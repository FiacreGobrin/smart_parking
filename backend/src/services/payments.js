import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';
import { env, momoSecret } from '../config/env.js';
import { AppError, badRequest, notFound, unprocessable } from '../utils/errors.js';
import { PROVIDERS, getProvider, getProviderByKey, sign } from '../integrations/payments/index.js';
import { findActiveSession, persistFee, quoteSession } from './parking.js';
import { getSetting } from './settings.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { emit } from '../sockets/index.js';

const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
// Sequential reference such as MM-2026-001245 (prefix = provider, year, database sequence).
async function newReference(db, providerKey) {
  const [{ n }] = await db.$queryRaw`SELECT nextval('payment_ref_seq')::int AS n`;
  const prefix = PROVIDERS[providerKey]?.prefix || 'CS';
  return `${prefix}-${new Date().getUTCFullYear()}-${String(n).padStart(6, '0')}`;
}
const newReceiptNo = () => `RCT-${stamp()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

async function buildReceipt(tx, payment) {
  const session = payment.sessionId
    ? await tx.parkingSession.findUnique({ where: { id: payment.sessionId }, include: { facility: true, space: true } })
    : null;
  const permit = payment.permitId
    ? await tx.parkingPermit.findUnique({ where: { id: payment.permitId }, include: { facility: true } })
    : null;
  const cashier = payment.receivedById ? await tx.user.findUnique({ where: { id: payment.receivedById }, select: { name: true } }) : null;
  const org = await getSetting('org.name');
  const footer = await getSetting('org.receiptFooter');
  return tx.receipt.create({
    data: {
      number: newReceiptNo(),
      paymentId: payment.id,
      snapshot: {
        organization: org, footer,
        service: session?.service, methodLabel: PROVIDERS[payment.provider]?.label || 'Cash',
        facility: session?.facility?.name ?? permit?.facility?.name, plate: session?.plate ?? permit?.plate, ticketNo: session?.ticketNo,
        permitNumber: permit?.number,
        space: session?.space?.code, entryAt: session?.entryAt, exitAt: session?.exitAt,
        durationMinutes: session?.durationMinutes, breakdown: session?.breakdown,
        amount: payment.amount.toString(), currency: payment.currency, method: payment.method,
        reference: payment.reference, cashier: cashier?.name, paidAt: payment.paidAt, simulated: payment.isSimulated,
      },
    },
  });
}

// Moves a payment to SUCCESS exactly once: receipt, session balance and audit commit together.
async function settle(tx, payment, req) {
  const updated = await tx.payment.updateMany({
    where: { id: payment.id, status: 'PENDING' },
    data: { status: 'SUCCESS', paidAt: new Date() },
  });
  if (updated.count === 0) return null; // already settled (idempotent)
  const fresh = await tx.payment.findUnique({ where: { id: payment.id } });
  if (fresh.sessionId) {
    await tx.parkingSession.update({ where: { id: fresh.sessionId }, data: { amountPaid: { increment: fresh.amount } } });
  }
  await buildReceipt(tx, fresh);
  await audit(req, { action: 'PAYMENT_SUCCEEDED', entity: 'Payment', entityId: fresh.id, metadata: { amount: fresh.amount.toString(), method: fresh.method, reference: fresh.reference } }, tx);
  return fresh;
}

export async function createPayment({ sessionId, method, provider: providerKey, amount, idempotencyKey, payerPhone, discountPercent, user, req }) {
  if (idempotencyKey) {
    const existing = await prisma.payment.findUnique({ where: { idempotencyKey }, include: { receipt: true } });
    if (existing) return { payment: existing, replay: true };
  }

  const session = await findActiveSession({ sessionId });
  if (session.status !== 'ACTIVE') throw new AppError(409, 'SESSION_CLOSED', 'Session is not active');
  const q = await quoteSession(session, { discountPercent });
  if (q.balanceDue.lte(0)) throw unprocessable('Nothing is due on this session');

  const due = q.balanceDue;
  const pay = amount != null ? new Decimal(amount) : due;
  if (pay.lte(0)) throw badRequest('Amount must be positive');
  if (pay.gt(due)) throw unprocessable(`Amount exceeds the balance due (${due.toFixed(2)})`);

  const isCash = method === 'CASH';
  const provider = isCash ? null : getProvider(method, providerKey);
  if (!isCash && !payerPhone) throw badRequest('A phone number is required for mobile money and bank payments');

  let payment;
  try {
    payment = await prisma.$transaction(async (tx) => {
      await persistFee(tx, session.id, q);
      const created = await tx.payment.create({
        data: {
          reference: await newReference(tx, provider?.key), idempotencyKey, sessionId: session.id, facilityId: session.facilityId,
          amount: pay.toFixed(2), currency: session.facility.currency, method, status: 'PENDING',
          provider: isCash ? 'cash' : provider.key, payerPhone, receivedById: user.id,
          isSimulated: provider?.isSimulated ?? false,
        },
      });
      await audit(req, { action: 'PAYMENT_CREATED', entity: 'Payment', entityId: created.id, metadata: { amount: pay.toFixed(2), method, sessionId: session.id } }, tx);
      return created;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && idempotencyKey) {
      const existing = await prisma.payment.findUnique({ where: { idempotencyKey }, include: { receipt: true } });
      if (existing) return { payment: existing, replay: true };
    }
    throw err;
  }

  if (isCash) {
    await prisma.$transaction((tx) => settle(tx, payment, req));
  } else {
    try {
      const { providerReference } = await provider.initiate({ payment, phone: payerPhone });
      await prisma.payment.update({ where: { id: payment.id }, data: { providerReference } });
    } catch (err) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureReason: err.message } });
      await notify({ type: 'PAYMENT_FAILED', severity: 'WARNING', title: 'Payment could not be started', message: `${payment.reference}: ${err.message}`, facilityId: session.facilityId });
      throw err;
    }
  }
  const result = await prisma.payment.findUnique({ where: { id: payment.id }, include: { receipt: true } });
  emit('payment:update', { id: result.id, status: result.status }, result.facilityId);
  return { payment: result, replay: false };
}

/**
 * Handles a provider callback. The signature is verified over the raw bytes, each provider event
 * is processed once (WebhookEvent unique key), and the amount must match what we asked for.
 */
export async function processWebhook(providerKey, rawBody, signature, req) {
  const provider = getProviderByKey(providerKey);
  if (!provider) throw notFound('Payment provider');
  if (!provider.verifyWebhook(rawBody, signature)) {
    await audit(req, { action: 'WEBHOOK_REJECTED', entity: 'Payment', result: 'DENIED', metadata: { provider: providerKey } });
    throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
  }
  let json;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw badRequest('Webhook body is not valid JSON');
  }
  const event = provider.parseWebhook(json);
  if (!event.eventId || !event.providerReference) throw badRequest('eventId and providerReference are required');

  try {
    await prisma.webhookEvent.create({ data: { provider: providerKey, eventId: event.eventId, payload: json } });
  } catch (err) {
    if (err.code === 'P2002') return { duplicate: true };
    throw err;
  }

  const payment = await prisma.payment.findUnique({ where: { providerReference: event.providerReference } });
  if (!payment) throw notFound('Payment');
  if (event.amount != null && !new Decimal(event.amount).eq(payment.amount)) {
    await audit(req, { action: 'WEBHOOK_AMOUNT_MISMATCH', entity: 'Payment', entityId: payment.id, result: 'DENIED', metadata: { expected: payment.amount.toString(), got: event.amount } });
    await notify({ type: 'SYSTEM_ERROR', severity: 'CRITICAL', title: 'Payment amount mismatch', message: `${payment.reference}: callback amount ${event.amount} != ${payment.amount}`, facilityId: payment.facilityId });
    throw unprocessable('Callback amount does not match the payment');
  }

  if (event.status === 'SUCCESS') {
    await prisma.$transaction((tx) => settle(tx, payment, req));
  } else {
    const r = await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'FAILED', failureReason: event.reason || 'Declined by provider' } });
    if (r.count) {
      await audit(req, { action: 'PAYMENT_FAILED', entity: 'Payment', entityId: payment.id, result: 'FAILED', metadata: { reason: event.reason } });
      await notify({ type: 'PAYMENT_FAILED', severity: 'WARNING', title: 'Payment failed', message: `${payment.reference}: ${event.reason || 'Declined by provider'}`, facilityId: payment.facilityId });
    }
  }
  const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
  emit('payment:update', { id: updated.id, status: updated.status }, updated.facilityId);
  return { duplicate: false, payment: updated };
}

// Development helper: sends a correctly signed callback through the same verified path.
export async function simulateCallback(paymentId, status, req) {
  if (env.PAYMENT_MODE !== 'simulation') throw new AppError(403, 'SIMULATION_DISABLED', 'Simulation is disabled in live payment mode');
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw notFound('Payment');
  const provider = getProviderByKey(payment.provider);
  if (!provider?.isSimulated) throw badRequest('Only simulated mobile money payments can be simulated');
  if (payment.status !== 'PENDING') throw new AppError(409, 'NOT_PENDING', 'Payment is not pending');
  const raw = Buffer.from(JSON.stringify({
    eventId: `sim-${crypto.randomUUID()}`, providerReference: payment.providerReference,
    status, amount: payment.amount.toString(), reason: status === 'FAILED' ? 'Simulated decline' : undefined,
  }));
  return processWebhook(provider.key, raw, sign(raw, momoSecret), req);
}

export async function refundPayment(paymentId, reason, user, req) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw notFound('Payment');
  if (payment.status !== 'SUCCESS') throw new AppError(409, 'NOT_REFUNDABLE', 'Only successful payments can be refunded');
  let providerReference;
  if (payment.method !== 'CASH' && payment.provider) {
    const provider = getProviderByKey(payment.provider);
    ({ providerReference } = await provider.refund(payment, reason));
  }
  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.payment.updateMany({
      where: { id: paymentId, status: 'SUCCESS' },
      data: { status: 'REFUNDED', refundedAt: new Date(), refundReason: reason, refundedById: user.id, metadata: providerReference ? { refundReference: providerReference } : undefined },
    });
    if (r.count === 0) throw new AppError(409, 'NOT_REFUNDABLE', 'Payment was already refunded');
    if (payment.sessionId) {
      await tx.parkingSession.update({ where: { id: payment.sessionId }, data: { amountPaid: { decrement: payment.amount } } });
    }
    await audit(req, { action: 'PAYMENT_REFUNDED', entity: 'Payment', entityId: paymentId, metadata: { reason, amount: payment.amount.toString() } }, tx);
    return tx.payment.findUnique({ where: { id: paymentId } });
  });
  emit('payment:update', { id: updated.id, status: updated.status }, updated.facilityId);
  return updated;
}

// Permit fees are collected in cash at the desk; electronic permit payments are not wired up.
export async function payPermitCash(permitId, amount, user, req) {
  const permit = await prisma.parkingPermit.findUnique({ where: { id: permitId }, include: { facility: true } });
  if (!permit) throw notFound('Permit');
  const value = new Decimal(amount ?? permit.fee);
  if (value.lte(0)) throw badRequest('Amount must be positive');
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        reference: await newReference(tx, null), permitId, facilityId: permit.facilityId, amount: value.toFixed(2),
        currency: permit.facility.currency, method: 'CASH', status: 'PENDING', provider: 'cash', receivedById: user.id,
      },
    });
    await settle(tx, payment, req);
    return tx.payment.findUnique({ where: { id: payment.id }, include: { receipt: true } });
  });
}
