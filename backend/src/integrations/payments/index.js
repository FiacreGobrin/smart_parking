// Payment provider adapters.
//
// Contract every adapter implements:
//   key                      string stored in Payment.provider
//   isSimulated              true when no real money moves
//   initiate({ payment, phone })  -> { providerReference }   (payment stays PENDING)
//   verifyWebhook(rawBody, signature) -> boolean
//   parseWebhook(json) -> { eventId, providerReference, status: 'SUCCESS'|'FAILED', amount, reason? }
//   refund(payment, reason) -> { providerReference }
//
// A payment is only marked SUCCESS by a verified webhook (or a server-side status lookup),
// never because the browser says so.
import crypto from 'node:crypto';
import { env, momoSecret } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

export function sign(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = Buffer.from(sign(rawBody, secret), 'hex');
  let given;
  try {
    given = Buffer.from(String(signature), 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const parseStandard = (json) => ({
  eventId: String(json.eventId || ''),
  providerReference: String(json.providerReference || ''),
  status: json.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
  amount: json.amount,
  reason: json.reason,
});

// Providers offered at the payment screen. `prefix` starts the human-readable reference (MM-2026-001245).
export const PROVIDERS = {
  'mtn-momo': { label: 'MTN MoMo', method: 'MOBILE_MONEY', prefix: 'MM' },
  'airtel-money': { label: 'Airtel Money', method: 'MOBILE_MONEY', prefix: 'AM' },
  'equity-bank': { label: 'Equity Bank', method: 'BANK', prefix: 'EQ' },
};

// DEVELOPMENT ONLY. Moves no money; lets the UI exercise the pending -> verified-callback flow.
const simulated = (key) => ({
  key,
  isSimulated: true,
  async initiate() {
    return { providerReference: `SIM-${crypto.randomBytes(6).toString('hex').toUpperCase()}` };
  },
  verifyWebhook: (raw, signature) => verifySignature(raw, signature, momoSecret),
  parseWebhook: parseStandard,
  async refund() {
    return { providerReference: `SIM-RF-${crypto.randomBytes(4).toString('hex').toUpperCase()}` };
  },
});

// Reference adapter for a generic REST collections API. Real providers (MTN MoMo, Airtel Money,
// Equity Bank) each have their own contract: adapt initiate/parseWebhook to the provider docs and
// configure MOMO_API_BASE_URL, MOMO_API_KEY and MOMO_WEBHOOK_SECRET.
const live = (key) => ({
  key,
  isSimulated: false,
  async initiate({ payment, phone }) {
    if (key === 'equity-bank' || !env.MOMO_API_BASE_URL || !env.MOMO_API_KEY || !momoSecret) {
      throw new AppError(501, 'PROVIDER_NOT_CONFIGURED', `${PROVIDERS[key].label} is not configured on this server`);
    }
    const res = await fetch(`${env.MOMO_API_BASE_URL}/collections/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MOMO_API_KEY}` },
      body: JSON.stringify({ provider: key, amount: payment.amount.toString(), currency: payment.currency, phone, externalId: payment.reference }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new AppError(502, 'PROVIDER_ERROR', `${PROVIDERS[key].label} rejected the request`);
    const body = await res.json();
    return { providerReference: String(body.providerReference || body.id) };
  },
  verifyWebhook: (raw, signature) => verifySignature(raw, signature, momoSecret),
  parseWebhook: parseStandard,
  async refund() {
    throw new AppError(501, 'PROVIDER_NOT_CONFIGURED', 'Automated refunds are not configured; refund manually with the provider');
  },
});

export function getProviderByKey(key) {
  if (!PROVIDERS[key]) return null;
  return env.PAYMENT_MODE === 'live' ? live(key) : simulated(key);
}

/** Resolves the adapter for a payment request; `providerKey` is optional for the single-provider methods. */
export function getProvider(method, providerKey) {
  const key = providerKey || (method === 'BANK' ? 'equity-bank' : method === 'MOBILE_MONEY' ? 'mtn-momo' : null);
  const def = key && PROVIDERS[key];
  if (!def || def.method !== method) {
    throw new AppError(501, 'PROVIDER_NOT_CONFIGURED', `${method} payments are not configured; use cash, mobile money or bank`);
  }
  return getProviderByKey(key);
}
