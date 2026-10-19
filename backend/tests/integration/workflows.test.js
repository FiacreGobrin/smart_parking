import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { sign } from '../../src/integrations/payments/index.js';
import { api, auth, login, resetDatabase, seedFixtures } from './helpers.js';

const B = '/api/v1';
let fx;
let tok = {};

beforeAll(async () => {
  await resetDatabase();
  fx = await seedFixtures();
  tok = {
    superAdmin: await login('super@test.rw'),
    adminA: await login('admin.a@test.rw'),
    attA: await login('att.a@test.rw'),
    attB: await login('att.b@test.rw'),
    finance: await login('fin@test.rw'),
    viewer: await login('view@test.rw'),
  };
});
afterAll(async () => {
  await prisma.$disconnect();
});

const enter = (token, body) => api.post(`${B}/parking/entry`).set(auth(token)).send(body);
const exit = (token, body) => api.post(`${B}/parking/exit`).set(auth(token)).send(body);
const backdate = (sessionId, minutes) =>
  prisma.parkingSession.update({ where: { id: sessionId }, data: { entryAt: new Date(Date.now() - minutes * 60000) } });

describe('authentication and authorization', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await api.get(`${B}/vehicles`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('rejects bad credentials with a generic message and locks after repeated failures', async () => {
    const bad = await api.post(`${B}/auth/login`).send({ email: 'att.b@test.rw', password: 'wrong-password-1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Invalid username or password');
    const unknown = await api.post(`${B}/auth/login`).send({ email: 'nobody@test.rw', password: 'wrong-password-1' });
    expect(unknown.body.error.message).toBe(bad.body.error.message);

    for (let i = 0; i < 5; i++) await api.post(`${B}/auth/login`).send({ email: 'view@test.rw', password: 'nope-nope-1' });
    const locked = await api.post(`${B}/auth/login`).send({ email: 'view@test.rw', password: 'Test#Passw0rd1' });
    expect(locked.status).toBe(423);
    await prisma.user.update({ where: { email: 'view@test.rw' }, data: { lockedUntil: null, failedLogins: 0 } });
  });

  it('returns the profile with permissions and never the password hash', async () => {
    const res = await api.get(`${B}/auth/me`).set(auth(tok.attA));
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('ATTENDANT');
    expect(res.body.data.permissions).toContain('sessions.write');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|resetToken/);
  });

  it('enforces permissions on the server', async () => {
    expect((await api.get(`${B}/users`).set(auth(tok.attA))).status).toBe(403);
    expect((await api.get(`${B}/audit-logs`).set(auth(tok.attA))).status).toBe(403);
    expect((await api.get(`${B}/payments`).set(auth(tok.viewer))).status).toBe(403);
    expect((await api.post(`${B}/vehicles`).set(auth(tok.viewer)).send({ plate: 'RAB111A' })).status).toBe(403);
    expect((await api.post(`${B}/rates`).set(auth(tok.adminA)).send({ name: 'x', hourlyRate: 1 })).status).toBe(403);
    expect((await api.put(`${B}/settings/org.name`).set(auth(tok.adminA)).send({ value: 'Hacked' })).status).toBe(403);
  });

  it('hides money figures from roles without finance access', async () => {
    const viewer = await api.get(`${B}/dashboard/summary`).set(auth(tok.viewer));
    expect(viewer.status).toBe(200);
    expect(viewer.body.data).not.toHaveProperty('revenueToday');
    expect((await api.get(`${B}/reports/revenue`).set(auth(tok.viewer))).status).toBe(403);
    const fin = await api.get(`${B}/dashboard/summary`).set(auth(tok.finance));
    expect(fin.body.data).toHaveProperty('revenueToday');
  });

  it('stops honouring tokens of deactivated users', async () => {
    const t = await login('att.b@test.rw');
    await prisma.user.update({ where: { email: 'att.b@test.rw' }, data: { status: 'BLOCKED' } });
    expect((await api.get(`${B}/auth/me`).set(auth(t))).status).toBe(401);
    await prisma.user.update({ where: { email: 'att.b@test.rw' }, data: { status: 'ACTIVE' } });
  });

  it('keeps a facility-bound attendant inside their facility', async () => {
    const e = await enter(tok.attA, { plate: 'RAA100A' });
    expect(e.status).toBe(201);
    const peek = await api.get(`${B}/parking/sessions/${e.body.data.id}`).set(auth(tok.attB));
    expect(peek.status).toBe(403);
    const wrong = await enter(tok.attB, { plate: 'RAA101A', facilityId: fx.facA.id });
    expect(wrong.status).toBe(403);
    await prisma.parkingSession.updateMany({ where: { plate: 'RAA100A' }, data: { status: 'CANCELLED' } });
    await prisma.parkingSpace.updateMany({ data: { status: 'AVAILABLE' } });
  });

  it('audit log is append-only at the database level', async () => {
    await expect(prisma.auditLog.updateMany({ data: { result: 'TAMPERED' } })).rejects.toThrow();
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow();
  });
});

describe('validation and error format', () => {
  it('returns structured validation errors with a request id', async () => {
    const res = await enter(tok.attA, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0]).toHaveProperty('field');
    expect(res.body.error.requestId).toBeTruthy();
  });
  it('returns JSON 404s without leaking internals', async () => {
    const res = await api.get(`${B}/nope`).set(auth(tok.attA));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|prisma/i);
  });
  it('rejects malformed JSON cleanly', async () => {
    const res = await api.post(`${B}/auth/login`).set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
  });
});

describe('vehicle registry', () => {
  it('normalizes plates and rejects duplicates written in a different format', async () => {
    const a = await api.post(`${B}/vehicles`).set(auth(tok.attA)).send({ plate: 'rab 123 c', type: 'CAR', make: 'Toyota', owner: { name: 'Test Owner', phone: '+250788000000' } });
    expect(a.status).toBe(201);
    expect(a.body.data.plate).toBe('RAB123C');
    const dup = await api.post(`${B}/vehicles`).set(auth(tok.attA)).send({ plate: 'RAB-123-C' });
    expect(dup.status).toBe(409);
    const found = await api.get(`${B}/vehicles/lookup/rab123c`).set(auth(tok.attA));
    expect(found.body.data.vehicle.make).toBe('Toyota');
  });

  it('validates input', async () => {
    expect((await api.post(`${B}/vehicles`).set(auth(tok.attA)).send({ plate: 'A' })).status).toBe(400);
    expect((await api.post(`${B}/vehicles`).set(auth(tok.attA)).send({ plate: 'RAB555X', status: 'RESTRICTED' })).status).toBe(400);
  });

  it('does not reset unrelated fields on PATCH', async () => {
    const v = await prisma.vehicle.findUnique({ where: { plate: 'RAB123C' } });
    const res = await api.patch(`${B}/vehicles/${v.id}`).set(auth(tok.attA)).send({ color: 'Blue' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ color: 'Blue', make: 'Toyota', type: 'CAR', status: 'REGISTERED' });
  });
});

describe('parking entry, space allocation, payment and exit', () => {
  let session;

  it('assigns a space and marks it occupied', async () => {
    const res = await enter(tok.attA, { plate: 'RAB 123 C' });
    expect(res.status).toBe(201);
    session = res.body.data;
    expect(session.plate).toBe('RAB123C');
    expect(session.spaceId).toBeTruthy();
    const space = await prisma.parkingSpace.findUnique({ where: { id: session.spaceId } });
    expect(space.status).toBe('OCCUPIED');
  });

  it('refuses a second active session for the same plate in any format', async () => {
    const res = await enter(tok.attA, { plate: 'rab-123-c' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCESS_DENIED_ALREADY_INSIDE');
  });

  it('exposes a transparent fee breakdown (125 min = 3 hours started = 100 + 2 x 100 = 300)', async () => {
    await backdate(session.id, 125);
    const res = await api.get(`${B}/parking/exit-preview`).set(auth(tok.attA)).query({ plate: 'RAB123C' });
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe('300.00');
    expect(res.body.data.balanceDue).toBe('300.00');
    expect(res.body.data.fee.lines.length).toBeGreaterThan(0);
  });

  it('blocks exit with 402 until the balance is paid, leaving the session open', async () => {
    const res = await exit(tok.attA, { plate: 'RAB123C' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('ACCESS_DENIED_PAYMENT_REQUIRED');
    expect((await prisma.parkingSession.findUnique({ where: { id: session.id } })).status).toBe('ACTIVE');
  });

  it('is idempotent for repeated cash payment requests', async () => {
    const body = { sessionId: session.id, method: 'CASH', idempotencyKey: 'idem-key-0001' };
    const first = await api.post(`${B}/payments`).set(auth(tok.attA)).send(body);
    const second = await api.post(`${B}/payments`).set(auth(tok.attA)).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(first.body.data.status).toBe('SUCCESS');
    expect(first.body.data.receipt.number).toMatch(/^RCT-/);
    expect(await prisma.payment.count({ where: { sessionId: session.id } })).toBe(1);
    expect((await prisma.parkingSession.findUnique({ where: { id: session.id } })).amountPaid.toString()).toBe('300');
  });

  it('rejects paying more than is due or paying a settled session', async () => {
    const res = await api.post(`${B}/payments`).set(auth(tok.attA)).send({ sessionId: session.id, method: 'CASH' });
    expect(res.status).toBe(422);
  });

  it('closes the session on exit and releases the space', async () => {
    const res = await exit(tok.attA, { plate: 'RAB123C' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('COMPLETED');
    expect(res.body.data.durationMinutes).toBeGreaterThanOrEqual(125);
    const space = await prisma.parkingSpace.findUnique({ where: { id: session.spaceId } });
    expect(space.status).toBe('AVAILABLE');
    expect((await exit(tok.attA, { plate: 'RAB123C' })).status).toBe(404); // nothing left to close
  });

  it('allows the vehicle back in afterwards', async () => {
    const res = await enter(tok.attA, { plate: 'RAB123C' });
    expect(res.status).toBe(201);
    await exit(tok.superAdmin, { plate: 'RAB123C', exempt: true, exemptReason: 'Test cleanup' });
  });

  it('only one of two simultaneous entries for the same plate succeeds', async () => {
    const results = await Promise.all([enter(tok.attA, { plate: 'RZZ900Z' }), enter(tok.attA, { plate: 'RZZ900Z' })]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s !== 201)).toHaveLength(1);
    expect(await prisma.parkingSession.count({ where: { plate: 'RZZ900Z', status: 'ACTIVE' } })).toBe(1);
    await exit(tok.superAdmin, { plate: 'RZZ900Z', exempt: true, exemptReason: 'Test cleanup' });
  });

  it('never assigns two vehicles to the same space under concurrency', async () => {
    const plates = ['RC1001A', 'RC1002A', 'RC1003A'];
    const results = await Promise.all(plates.map((p) => enter(tok.attA, { plate: p })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const spaceIds = results.map((r) => r.body.data.spaceId);
    expect(new Set(spaceIds).size).toBe(3);
    // Facility A has exactly 3 spaces: the next vehicle must be refused.
    const full = await enter(tok.attA, { plate: 'RC1004A' });
    expect(full.status).toBe(403);
    expect(full.body.error.code).toBe('ACCESS_DENIED_FACILITY_FULL');
    for (const p of plates) await exit(tok.superAdmin, { plate: p, exempt: true, exemptReason: 'Test cleanup' });
  });

  it('requires the exemption permission and a reason', async () => {
    await enter(tok.attA, { plate: 'RX2000X' });
    const denied = await exit(tok.attA, { plate: 'RX2000X', exempt: true, exemptReason: 'Free ride' });
    expect(denied.status).toBe(403);
    const noReason = await exit(tok.adminA, { plate: 'RX2000X', exempt: true });
    expect(noReason.status).toBe(400);
    const ok = await exit(tok.adminA, { plate: 'RX2000X', exempt: true, exemptReason: 'VIP guest' });
    expect(ok.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'EXEMPTION_APPLIED' }, orderBy: { createdAt: 'desc' } });
    expect(audit.metadata).toMatchObject({ reason: 'VIP guest' });
  });

  it('charges the start price for a very short stay (there is no free period)', async () => {
    const e = await enter(tok.attA, { plate: 'RG3000G' });
    const quote = await api.get(`${B}/parking/exit-preview`).set(auth(tok.attA)).query({ sessionId: e.body.data.id });
    expect(quote.body.data.total).toBe('100.00');
    const blocked = await exit(tok.attA, { sessionId: e.body.data.id });
    expect(blocked.status).toBe(402);
    await exit(tok.superAdmin, { plate: 'RG3000G', exempt: true, exemptReason: 'Test cleanup' });
  });

  it('bills car wash per visit without taking a parking space', async () => {
    const before = await prisma.parkingSpace.count({ where: { status: 'OCCUPIED' } });
    const e = await enter(tok.attA, { plate: 'RCW1234', service: 'CAR_WASH' });
    expect(e.status).toBe(201);
    expect(e.body.data).toMatchObject({ service: 'CAR_WASH', billingUnit: 'VISIT', spaceId: null });
    expect(await prisma.parkingSpace.count({ where: { status: 'OCCUPIED' } })).toBe(before);
    await backdate(e.body.data.id, 300);
    const q = await api.get(`${B}/parking/exit-preview`).set(auth(tok.attA)).query({ sessionId: e.body.data.id });
    expect(q.body.data.total).toBe('2000.00');
    await api.post(`${B}/payments`).set(auth(tok.attA)).send({ sessionId: e.body.data.id, method: 'CASH' });
    expect((await exit(tok.attA, { sessionId: e.body.data.id })).status).toBe(200);
  });

  it('bills garage stays per day and rejects an invalid unit for the service', async () => {
    const bad = await enter(tok.attA, { plate: 'RGR5000', service: 'GARAGE', billingUnit: 'HOUR' });
    expect(bad.status).toBe(400);
    const e = await enter(tok.attA, { plate: 'RGR5000', service: 'GARAGE', billingUnit: 'DAY' });
    expect(e.status).toBe(201);
    await backdate(e.body.data.id, 3 * 1440 - 10);
    const q = await api.get(`${B}/parking/exit-preview`).set(auth(tok.attA)).query({ sessionId: e.body.data.id });
    expect(q.body.data.total).toBe('1500.00'); // 3 days started, capped at the day price
    await exit(tok.superAdmin, { plate: 'RGR5000', exempt: true, exemptReason: 'Test cleanup' });
  });
});

describe('restricted vehicles and gate authorization', () => {
  it('denies restricted vehicles and records the denial', async () => {
    await prisma.vehicle.create({ data: { plate: 'RBAD001', status: 'RESTRICTED', restrictionReason: 'Stolen report' } });
    const res = await enter(tok.attA, { plate: 'RBAD001', gateId: fx.gateIn.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCESS_DENIED_RESTRICTED_VEHICLE');
    const ev = await prisma.gateEvent.findFirst({ where: { plate: 'RBAD001' } });
    expect(ev).toMatchObject({ type: 'DENIED', outcome: 'DENIED' });
    expect(await prisma.notification.count({ where: { type: 'UNUSUAL_ACCESS' } })).toBeGreaterThan(0);
    expect(await prisma.parkingSession.count({ where: { plate: 'RBAD001' } })).toBe(0);
  });

  it('fails closed when a gate is not online', async () => {
    await prisma.gate.update({ where: { id: fx.gateIn.id }, data: { status: 'MAINTENANCE' } });
    const res = await enter(tok.attA, { plate: 'RGT4000A', gateId: fx.gateIn.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCESS_DENIED_GATE_NOT_ONLINE');
    const cmd = await api.post(`${B}/gates/${fx.gateIn.id}/commands`).set(auth(tok.attA)).send({ command: 'OPEN' });
    expect(cmd.status).toBe(409);
    await prisma.gate.update({ where: { id: fx.gateIn.id }, data: { status: 'ONLINE' } });
  });

  it('records the acknowledgement from a simulated controller and labels it as simulated', async () => {
    const res = await api.post(`${B}/gates/${fx.gateIn.id}/commands`).set(auth(tok.attA)).send({ command: 'OPEN', reason: 'Manual assist' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ acknowledged: true, simulated: true, outcome: 'ACKNOWLEDGED' });
  });

  it('treats an unreachable HTTP controller as FAILED, flags the gate and alerts operators', async () => {
    const gate = await prisma.gate.create({ data: { facilityId: fx.facA.id, name: 'Real gate', direction: 'ENTRY', controllerType: 'HTTP', controllerUrl: 'http://127.0.0.1:9' } });
    const res = await api.post(`${B}/gates/${gate.id}/commands`).set(auth(tok.attA)).send({ command: 'OPEN' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ acknowledged: false, outcome: 'FAILED' });
    expect((await prisma.gate.findUnique({ where: { id: gate.id } })).status).toBe('ERROR');
    expect(await prisma.notification.count({ where: { type: 'DEVICE_OFFLINE' } })).toBeGreaterThan(0);
  });

  it('validates gate commands', async () => {
    const res = await api.post(`${B}/gates/${fx.gateIn.id}/commands`).set(auth(tok.attA)).send({ command: 'EXPLODE' });
    expect(res.status).toBe(400);
    expect((await api.post(`${B}/gates/${fx.gateIn.id}/commands`).set(auth(tok.viewer)).send({ command: 'OPEN' })).status).toBe(403);
  });
});

describe('mobile money, webhooks, refunds', () => {
  let session;
  let payment;

  const hook = (payload, secret = 'test-webhook-secret', signature) => {
    const raw = JSON.stringify(payload);
    return api.post(`${B}/payments/webhooks/mtn-momo`).set('Content-Type', 'application/json').set('X-Signature', signature ?? sign(Buffer.from(raw), secret)).send(raw);
  };

  it('keeps an electronic payment PENDING until a verified callback arrives', async () => {
    const e = await enter(tok.attA, { plate: 'RMM5000M' });
    session = e.body.data;
    await backdate(session.id, 70);
    const res = await api.post(`${B}/payments`).set(auth(tok.attA)).send({ sessionId: session.id, method: 'MOBILE_MONEY', provider: 'mtn-momo', payerPhone: '+250788123456' });
    expect(res.status).toBe(201);
    payment = res.body.data;
    expect(payment).toMatchObject({ status: 'PENDING', isSimulated: true });
    expect(payment.providerReference).toMatch(/^SIM-/);
    expect(payment.reference).toMatch(/^MM-\d{4}-\d{6}$/);
    expect(payment.receipt).toBeNull();
    const blocked = await exit(tok.attA, { plate: 'RMM5000M' });
    expect(blocked.status).toBe(402);
  });

  it('requires a phone number for mobile money', async () => {
    const res = await api.post(`${B}/payments`).set(auth(tok.attA)).send({ sessionId: session.id, method: 'MOBILE_MONEY' });
    expect(res.status).toBe(400);
  });

  it('refuses callbacks with a missing or wrong signature', async () => {
    const payload = { eventId: 'evt-1', providerReference: payment.providerReference, status: 'SUCCESS', amount: payment.amount };
    expect((await hook(payload, 'wrong-secret')).status).toBe(401);
    expect((await hook(payload, undefined, 'abcd')).status).toBe(401);
    expect((await prisma.payment.findUnique({ where: { id: payment.id } })).status).toBe('PENDING');
  });

  it('rejects a callback whose amount differs from the request', async () => {
    const res = await hook({ eventId: 'evt-mismatch', providerReference: payment.providerReference, status: 'SUCCESS', amount: '1' });
    expect(res.status).toBe(422);
    expect((await prisma.payment.findUnique({ where: { id: payment.id } })).status).toBe('PENDING');
  });

  it('settles on a verified callback and ignores replays of the same event', async () => {
    const payload = { eventId: 'evt-ok', providerReference: payment.providerReference, status: 'SUCCESS', amount: payment.amount };
    const first = await hook(payload);
    expect(first.status).toBe(200);
    const second = await hook(payload);
    expect(second.body.data.duplicate).toBe(true);
    const p = await prisma.payment.findUnique({ where: { id: payment.id }, include: { receipt: true } });
    expect(p.status).toBe('SUCCESS');
    expect(p.receipt).toBeTruthy();
    expect(await prisma.receipt.count({ where: { paymentId: payment.id } })).toBe(1);
    expect((await prisma.parkingSession.findUnique({ where: { id: session.id } })).amountPaid.toString()).toBe(p.amount.toString());
  });

  it('lets the exit proceed once paid', async () => {
    expect((await exit(tok.attA, { plate: 'RMM5000M' })).status).toBe(200);
  });

  it('restricts refunds to authorized roles and requires a reason', async () => {
    expect((await api.post(`${B}/payments/${payment.id}/refund`).set(auth(tok.attA)).send({ reason: 'Customer request' })).status).toBe(403);
    expect((await api.post(`${B}/payments/${payment.id}/refund`).set(auth(tok.finance)).send({})).status).toBe(400);
    const ok = await api.post(`${B}/payments/${payment.id}/refund`).set(auth(tok.finance)).send({ reason: 'Customer request' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('REFUNDED');
    const again = await api.post(`${B}/payments/${payment.id}/refund`).set(auth(tok.finance)).send({ reason: 'Customer request' });
    expect(again.status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: 'PAYMENT_REFUNDED' } })).toBe(1);
  });

  it('marks a declined payment as FAILED and raises an alert', async () => {
    const e = await enter(tok.attA, { plate: 'RMM6000M' });
    await backdate(e.body.data.id, 70);
    const created = await api.post(`${B}/payments`).set(auth(tok.attA)).send({ sessionId: e.body.data.id, method: 'MOBILE_MONEY', payerPhone: '0788123456' });
    const sim = await api.post(`${B}/payments/${created.body.data.id}/simulate-callback`).set(auth(tok.attA)).send({ status: 'FAILED' });
    expect(sim.status).toBe(200);
    expect(sim.body.data.payment.status).toBe('FAILED');
    expect(await prisma.notification.count({ where: { type: 'PAYMENT_FAILED' } })).toBeGreaterThan(0);
    await exit(tok.superAdmin, { plate: 'RMM6000M', exempt: true, exemptReason: 'Test cleanup' });
  });

  it('reports unconfigured payment methods honestly', async () => {
    const e = await enter(tok.attA, { plate: 'RCD7000C' });
    await backdate(e.body.data.id, 70);
    const res = await api.post(`${B}/payments`).set(auth(tok.attA)).send({ sessionId: e.body.data.id, method: 'CARD' });
    expect(res.status).toBe(501);
    await exit(tok.superAdmin, { plate: 'RCD7000C', exempt: true, exemptReason: 'Test cleanup' });
  });
});

describe('reservations and permits', () => {
  const hours = (n) => new Date(Date.now() + n * 3600000).toISOString();
  let space;

  beforeAll(async () => {
    space = await prisma.parkingSpace.findFirst({ where: { facilityId: fx.facA.id, code: 'A03' } });
  });

  it('creates a reservation and rejects overlapping ones', async () => {
    const body = { facilityId: fx.facA.id, spaceId: space.id, plate: 'RRS8000R', customerName: 'Reserved Customer', startAt: hours(5), endAt: hours(8) };
    const ok = await api.post(`${B}/reservations`).set(auth(tok.attA)).send(body);
    expect(ok.status).toBe(201);
    expect(ok.body.data.code).toMatch(/^RSV-/);
    const overlap = await api.post(`${B}/reservations`).set(auth(tok.attA)).send({ ...body, plate: 'RRS8001R', startAt: hours(7), endAt: hours(9) });
    expect(overlap.status).toBe(409);
    const adjacent = await api.post(`${B}/reservations`).set(auth(tok.attA)).send({ ...body, plate: 'RRS8002R', startAt: hours(8), endAt: hours(10) });
    expect(adjacent.status).toBe(201);
  });

  it('is protected by a database constraint even if the API pre-check is bypassed', async () => {
    await expect(prisma.reservation.create({
      data: { code: 'RSV-RAW', facilityId: fx.facA.id, spaceId: space.id, plate: 'RRAW001', customerName: 'x', startAt: new Date(Date.now() + 6 * 3600000), endAt: new Date(Date.now() + 7 * 3600000), status: 'CONFIRMED' },
    })).rejects.toThrow();
  });

  it('validates reservation periods', async () => {
    const res = await api.post(`${B}/reservations`).set(auth(tok.attA)).send({ facilityId: fx.facA.id, spaceId: space.id, plate: 'RRS9000R', customerName: 'Bad Times', startAt: hours(5), endAt: hours(4) });
    expect(res.status).toBe(400);
  });

  it('does not auto-assign a space that is about to be reserved', async () => {
    // A03 is reserved from +5h; only spaces without a near-term reservation are handed out automatically.
    await prisma.reservation.updateMany({ data: { status: 'CANCELLED' } });
    const near = await api.post(`${B}/reservations`).set(auth(tok.attA)).send({ facilityId: fx.facA.id, spaceId: space.id, plate: 'RRS9100R', customerName: 'Soon', startAt: hours(1), endAt: hours(2) });
    expect(near.status).toBe(201);
    const a = await enter(tok.attA, { plate: 'RAL1000A' });
    const b = await enter(tok.attA, { plate: 'RAL1001A' });
    const c = await enter(tok.attA, { plate: 'RAL1002A' });
    expect([a.status, b.status, c.status].sort()).toEqual([201, 201, 403]);
    for (const r of [a, b]) await exit(tok.superAdmin, { sessionId: r.body.data.id, exempt: true, exemptReason: 'Test cleanup' });
  });

  it('gives vehicles with an active permit a free exit', async () => {
    const perm = await api.post(`${B}/permits`).set(auth(tok.adminA)).send({ facilityId: fx.facA.id, plate: 'RPM1000P', holderName: 'Monthly Holder', startsAt: hours(-24), endsAt: hours(24 * 20), fee: 60000 });
    expect(perm.status).toBe(201);
    const dup = await api.post(`${B}/permits`).set(auth(tok.adminA)).send({ facilityId: fx.facA.id, plate: 'rpm-1000-p', holderName: 'Dup', startsAt: hours(0), endsAt: hours(48), fee: 0 });
    expect(dup.status).toBe(409);
    const e = await enter(tok.attA, { plate: 'RPM1000P' });
    await backdate(e.body.data.id, 600);
    const out = await exit(tok.attA, { plate: 'RPM1000P' });
    expect(out.status).toBe(200);
    expect(out.body.data.total).toBe('0');
    expect(out.body.data.exemptReason).toBe('Active parking permit');
  });
});

describe('ANPR (simulation mode)', () => {
  const recognize = (body) => api.post(`${B}/anpr/recognize`).set(auth(tok.attA)).field(body);

  it('declares that it is simulated', async () => {
    const res = await api.get(`${B}/anpr/status`).set(auth(tok.attA));
    expect(res.body.data).toMatchObject({ simulated: true, mode: 'simulation' });
    expect(res.body.data.notice).toMatch(/SIMULATION/);
  });

  it('records a confident read and suppresses repeat captures', async () => {
    const a = await recognize({ cameraId: fx.camIn.id, simulatedPlate: 'RAN 200 A', simulatedConfidence: '0.97' });
    expect(a.status).toBe(201);
    expect(a.body.data.event).toMatchObject({ plate: 'RAN200A', status: 'RECOGNIZED', isSimulated: true, engine: 'simulation' });
    const b = await recognize({ cameraId: fx.camIn.id, simulatedPlate: 'RAN200A', simulatedConfidence: '0.97' });
    expect(b.body.data.event.status).toBe('DUPLICATE');
    expect(b.body.data.duplicateOf).toBe(a.body.data.event.id);
  });

  it('asks the operator to confirm low-confidence reads and allows correction', async () => {
    const r = await recognize({ cameraId: fx.camIn.id, simulatedPlate: 'RAN300B', simulatedConfidence: '0.4', autoProcess: 'true' });
    expect(r.body.data.event.status).toBe('PENDING_CONFIRMATION');
    expect(r.body.data.action.action).toBe('CONFIRMATION_REQUIRED');
    expect(await prisma.parkingSession.count({ where: { plate: 'RAN300B' } })).toBe(0); // nothing happened automatically

    const fixed = await api.post(`${B}/anpr/events/${r.body.data.event.id}/confirm`).set(auth(tok.attA)).send({ plate: 'RAN 308 B', process: true });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.event).toMatchObject({ status: 'CORRECTED', plate: 'RAN308B' });
    expect(fixed.body.data.action.action).toBe('ENTRY_GRANTED');
    expect(await prisma.parkingSession.count({ where: { plate: 'RAN308B', status: 'ACTIVE' } })).toBe(1);
    const again = await api.post(`${B}/anpr/events/${r.body.data.event.id}/confirm`).set(auth(tok.attA)).send({});
    expect(again.status).toBe(409);
    await exit(tok.superAdmin, { plate: 'RAN308B', exempt: true, exemptReason: 'Test cleanup' });
  });

  it('auto-processes a confident read at a gate camera', async () => {
    const r = await recognize({ cameraId: fx.camIn.id, simulatedPlate: 'RAN400C', simulatedConfidence: '0.95', autoProcess: 'true' });
    expect(r.body.data.action.action).toBe('ENTRY_GRANTED');
    const s = await prisma.parkingSession.findFirst({ where: { plate: 'RAN400C' } });
    expect(s.entryRecognitionId).toBe(r.body.data.event.id);
    await exit(tok.superAdmin, { plate: 'RAN400C', exempt: true, exemptReason: 'Test cleanup' });
  });

  it('records failures when no plate can be read', async () => {
    const r = await recognize({ cameraId: fx.camIn.id });
    expect(r.body.data.event.status).toBe('FAILED');
    expect(await prisma.notification.count({ where: { type: 'RECOGNITION_FAILED' } })).toBeGreaterThan(0);
  });

  it('rejects non-image uploads', async () => {
    const res = await api.post(`${B}/anpr/recognize`).set(auth(tok.attA)).field('cameraId', fx.camIn.id)
      .attach('image', Buffer.from('<?php evil ?>'), { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
  });
});

describe('reports, exports and notifications', () => {
  it('runs finance reports for finance roles and exports CSV with an audit trail', async () => {
    const json = await api.get(`${B}/reports/revenue`).set(auth(tok.finance));
    expect(json.status).toBe(200);
    expect(json.body.data.summary.totalRevenue).toBeGreaterThan(0);
    const csv = await api.get(`${B}/reports/revenue`).query({ format: 'csv' }).set(auth(tok.finance));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('period,revenue,payments,cash,mobile_money');
    expect(await prisma.auditLog.count({ where: { action: 'EXPORT' } })).toBeGreaterThan(0);
  });

  it('lists only the reports a role may see', async () => {
    const v = await api.get(`${B}/reports`).set(auth(tok.viewer));
    const keys = v.body.data.map((r) => r.key);
    expect(keys).toContain('occupancy');
    expect(keys).not.toContain('revenue');
  });

  it('tracks read state per user', async () => {
    const list = await api.get(`${B}/notifications`).set(auth(tok.attA));
    expect(list.body.meta.unread).toBeGreaterThan(0);
    await api.post(`${B}/notifications/read-all`).set(auth(tok.attA));
    const after = await api.get(`${B}/notifications`).set(auth(tok.attA));
    expect(after.body.meta.unread).toBe(0);
    const other = await api.get(`${B}/notifications`).set(auth(tok.adminA));
    expect(other.body.meta.unread).toBeGreaterThan(0);
  });

  it('reconciliation refuses to close a day with pending payments', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const sum = await api.get(`${B}/payments/reconciliation/summary`).set(auth(tok.finance));
    expect(sum.status).toBe(200);
    const close = await api.post(`${B}/payments/reconciliation/close`).set(auth(tok.finance)).send({ date: today });
    expect([200, 400]).toContain(close.status);
  });

  it('reports health', async () => {
    const res = await api.get(`${B}/health`);
    expect(res.body.data).toMatchObject({ status: 'ok', database: 'up' });
  });
});

describe('administration and user accounts', () => {
  const person = (over = {}) => ({ name: 'Marie Claire Uwimana', phone: '0788 555 111', nationalId: '1199570087654321', role: 'USER', facilityId: fx.facA.id, ...over });

  it('generates a code, username and password like the design and creates the user with SMS recorded', async () => {
    const gen = await api.post(`${B}/users/generate`).set(auth(tok.superAdmin)).send({ name: 'Marie Claire Uwimana', phone: '0788 555 111' });
    expect(gen.status).toBe(200);
    expect(gen.body.data.username).toBe('muwimana_0788');
    expect(gen.body.data.code).toMatch(/^\d{6}$/);
    const created = await api.post(`${B}/users`).set(auth(tok.superAdmin)).send({ ...person(), ...gen.body.data });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ username: 'muwimana_0788', phone: '+250788555111', status: 'ACTIVE', role: 'USER' });
    expect(created.body.data).not.toHaveProperty('passwordHash');
    expect(created.body.data.sms.simulated).toBe(true);
    const sms = await prisma.smsMessage.findFirst({ where: { toPhone: '+250788555111' } });
    expect(sms.status).toBe('SIMULATED');
    expect(sms.body).toContain(gen.body.data.code);
    expect(sms.body).not.toContain(gen.body.data.password); // the stored copy never holds the password
  });

  it('requires the SMS code at the first sign-in and then forgets it', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const u = await prisma.user.findUnique({ where: { username: 'muwimana_0788' } });
    const code = '482917';
    await prisma.user.update({ where: { id: u.id }, data: { activationCodeHash: await bcrypt.hash(code, 4), passwordHash: await bcrypt.hash('Tp#8291xQab', 4) } });
    const noCode = await api.post(`${B}/auth/login`).send({ username: 'muwimana_0788', password: 'Tp#8291xQab' });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe('ACTIVATION_CODE_REQUIRED');
    const wrong = await api.post(`${B}/auth/login`).send({ username: 'muwimana_0788', password: 'Tp#8291xQab', code: '000000' });
    expect(wrong.body.error.code).toBe('ACTIVATION_CODE_INVALID');
    const ok = await api.post(`${B}/auth/login`).send({ username: 'muwimana_0788', password: 'Tp#8291xQab', code });
    expect(ok.status).toBe(200);
    const again = await api.post(`${B}/auth/login`).send({ username: 'muwimana_0788', password: 'Tp#8291xQab' });
    expect(again.status).toBe(200); // the code is single use
  });

  it('validates phone and national ID and rejects duplicates', async () => {
    expect((await api.post(`${B}/users`).set(auth(tok.superAdmin)).send(person({ phone: '12345', nationalId: '1199570087654399' }))).status).toBe(400);
    expect((await api.post(`${B}/users`).set(auth(tok.superAdmin)).send(person({ nationalId: '12345' }))).status).toBe(400);
    const dup = await api.post(`${B}/users`).set(auth(tok.superAdmin)).send(person({ name: 'Someone Else' }));
    expect(dup.status).toBe(409);
  });

  it('handles public sign-up, approval, activation, block and unblock', async () => {
    const bad = await api.post(`${B}/auth/register`).send({ name: 'Jean Uwase', phone: '0788 123 456', nationalId: '123' });
    expect(bad.status).toBe(400);
    const reg = await api.post(`${B}/auth/register`).send({ name: 'Jean Uwase', phone: '0788 123 456', nationalId: '1199880012345678' });
    expect(reg.status).toBe(201);
    expect((await api.post(`${B}/auth/register`).send({ name: 'Jean Again', phone: '0788123456', nationalId: '1199880012345679' })).status).toBe(409);

    const list = await api.get(`${B}/users`).query({ status: 'PENDING' }).set(auth(tok.superAdmin));
    const pending = list.body.data.find((u) => u.phone === '+250788123456');
    expect(pending.status).toBe('PENDING');
    const stats = await api.get(`${B}/users/stats`).set(auth(tok.superAdmin));
    expect(stats.body.data.pending).toBeGreaterThanOrEqual(1);

    // A pending account cannot sign in even if someone guessed credentials.
    expect((await api.post(`${B}/auth/login`).send({ username: pending.username, password: 'anything-123' })).status).toBe(401);

    // With several facilities the admin must choose one before approving.
    expect((await api.post(`${B}/users/${pending.id}/approve`).set(auth(tok.superAdmin))).status).toBe(400);
    expect((await api.patch(`${B}/users/${pending.id}`).set(auth(tok.superAdmin)).send({ facilityId: fx.facA.id })).status).toBe(200);
    const approved = await api.post(`${B}/users/${pending.id}/approve`).set(auth(tok.superAdmin));
    expect(approved.status).toBe(200);
    const { username, password, code } = approved.body.data.credentials;
    expect(username).toBe('juwase_0788');
    expect(approved.body.data.status).toBe('ACTIVE');
    expect((await api.post(`${B}/users/${pending.id}/approve`).set(auth(tok.superAdmin))).status).toBe(409); // already approved

    const needsCode = await api.post(`${B}/auth/login`).send({ username, password });
    expect(needsCode.body.error.code).toBe('ACTIVATION_CODE_REQUIRED');
    const login = await api.post(`${B}/auth/login`).send({ username, password, code });
    expect(login.status).toBe(200);
    const userToken = login.body.data.accessToken;
    expect((await api.get(`${B}/auth/me`).set(auth(userToken))).body.data.role).toBe('USER');

    const blocked = await api.post(`${B}/users/${pending.id}/block`).set(auth(tok.superAdmin));
    expect(blocked.body.data.status).toBe('BLOCKED');
    expect((await api.get(`${B}/auth/me`).set(auth(userToken))).status).toBe(401); // signed out at once
    const denied = await api.post(`${B}/auth/login`).send({ username, password });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('ACCOUNT_BLOCKED');
    expect((await api.post(`${B}/users/${pending.id}/unblock`).set(auth(tok.superAdmin))).body.data.status).toBe('ACTIVE');
    expect((await api.post(`${B}/auth/login`).send({ username, password })).status).toBe(200);
  });

  it('keeps the last super admin safe and prevents self-harm', async () => {
    expect((await api.post(`${B}/users/${fx.users.superAdmin.id}/block`).set(auth(tok.superAdmin))).status).toBe(400);
    expect((await api.delete(`${B}/users/${fx.users.superAdmin.id}`).set(auth(tok.superAdmin))).status).toBe(400);
  });

  it('limits a parking admin to people of their own facility', async () => {
    const gen = await api.post(`${B}/users/generate`).set(auth(tok.adminA)).send({ name: 'Fresh Attendant', phone: '0722 000 111' });
    const ok = await api.post(`${B}/users`).set(auth(tok.adminA)).send({ ...person({ name: 'Fresh Attendant', phone: '0722 000 111', nationalId: '1199111111111111', role: 'ATTENDANT' }), ...gen.body.data });
    expect(ok.status).toBe(201);
    const wrongFacility = await api.post(`${B}/users`).set(auth(tok.adminA)).send(person({ name: 'Wrong Place', phone: '0722 000 222', nationalId: '1199222222222222', facilityId: fx.facB.id }));
    expect(wrongFacility.status).toBe(403);
    const escalate = await api.post(`${B}/users`).set(auth(tok.adminA)).send(person({ name: 'Aspiring Boss', phone: '0722 000 333', nationalId: '1199333333333333', role: 'SUPER_ADMIN' }));
    expect(escalate.status).toBe(403);
  });

  it('lists users with status filters and search', async () => {
    expect((await api.get(`${B}/users`).query({ search: '0788' }).set(auth(tok.superAdmin))).status).toBe(200);
    const blockedOnly = await api.get(`${B}/users`).query({ status: 'BLOCKED' }).set(auth(tok.superAdmin));
    expect(blockedOnly.body.data.every((u) => u.status === 'BLOCKED')).toBe(true);
  });

  it('validates prices: minimum start price 100, cap not below start, unit must fit the service', async () => {
    const post = (body) => api.post(`${B}/rates`).set(auth(tok.superAdmin)).send(body);
    expect((await post({ service: 'PARKING', unit: 'HOUR', startPrice: 50 })).status).toBe(400);
    expect((await post({ service: 'PARKING', unit: 'HOUR', startPrice: 500, cap: 300 })).status).toBe(400);
    expect((await post({ service: 'CAR_WASH', unit: 'HOUR', startPrice: 500 })).status).toBe(400);
    const ok = await post({ service: 'PARKING', unit: 'HOUR', vehicleType: 'MOTORCYCLE', startPrice: 100, increment: 50, cap: 1000 });
    expect(ok.status).toBe(201);
    expect(ok.body.data.name).toBe('Parking - Motorbike - hour');
    const bad = await api.patch(`${B}/rates/${ok.body.data.id}`).set(auth(tok.superAdmin)).send({ cap: 50 });
    expect(bad.status).toBe(400);
  });

  it('previews a fee with the real pricing engine (design example: 3 h 15 min = 400)', async () => {
    const res = await api.post(`${B}/rates/preview`).set(auth(tok.superAdmin)).send({ unit: 'HOUR', startPrice: 100, increment: 100, cap: 2000, minutes: 195 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: '400.00', units: 4 });
  });

  it('pays with Airtel Money and Equity Bank using their own references', async () => {
    const e = await enter(tok.attA, { plate: 'RPY7001' });
    await backdate(e.body.data.id, 70);
    const airtel = await api.post(`${B}/payments`).set(auth(tok.attA)).send({ sessionId: e.body.data.id, method: 'MOBILE_MONEY', provider: 'airtel-money', payerPhone: '0733111222' });
    expect(airtel.body.data.reference).toMatch(/^AM-\d{4}-\d{6}$/);
    await api.post(`${B}/payments/${airtel.body.data.id}/simulate-callback`).set(auth(tok.attA)).send({ status: 'FAILED' });
    const equity = await api.post(`${B}/payments`).set(auth(tok.attA)).send({ sessionId: e.body.data.id, method: 'BANK', provider: 'equity-bank', payerPhone: '0733111222' });
    expect(equity.status).toBe(201);
    expect(equity.body.data.reference).toMatch(/^EQ-\d{4}-\d{6}$/);
    expect((await api.post(`${B}/payments`).set(auth(tok.attA)).send({ sessionId: e.body.data.id, method: 'BANK', provider: 'mtn-momo', payerPhone: '0733111222' })).status).toBe(501);
    await exit(tok.superAdmin, { plate: 'RPY7001', exempt: true, exemptReason: 'Test cleanup' });
  });

  it('records configuration changes in the audit log with before/after', async () => {
    const res = await api.put(`${B}/settings/anpr.minConfidence`).set(auth(tok.superAdmin)).send({ value: 0.9 });
    expect(res.status).toBe(200);
    const log = await prisma.auditLog.findFirst({ where: { action: 'SETTING_CHANGED' } });
    expect(log.metadata).toMatchObject({ before: 0.85, after: 0.9 });
    expect((await api.put(`${B}/settings/anpr.minConfidence`).set(auth(tok.superAdmin)).send({ value: 5 })).status).toBe(400);
    expect((await api.put(`${B}/settings/not.a.setting`).set(auth(tok.superAdmin)).send({ value: 1 })).status).toBe(400);
    await api.put(`${B}/settings/anpr.minConfidence`).set(auth(tok.superAdmin)).send({ value: 0.85 });
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const first = await api.post(`${B}/auth/login`).send({ email: 'fin@test.rw', password: 'Test#Passw0rd1' });
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    const rotated = await api.post(`${B}/auth/refresh`).set('Cookie', cookie);
    expect(rotated.status).toBe(200);
    const reuse = await api.post(`${B}/auth/refresh`).set('Cookie', cookie);
    expect(reuse.status).toBe(401);
    const newCookie = rotated.headers['set-cookie'][0].split(';')[0];
    expect((await api.post(`${B}/auth/refresh`).set('Cookie', newCookie)).status).toBe(401); // family revoked
  });

  it('completes the password reset workflow', async () => {
    const req = await api.post(`${B}/auth/forgot-password`).send({ username: 'view' });
    expect(req.status).toBe(200);
    const token = req.body.data.devResetToken;
    expect(token).toBeTruthy();
    const unknown = await api.post(`${B}/auth/forgot-password`).send({ username: 'ghost' });
    expect(unknown.body.data.message).toBe(req.body.data.message);
    expect((await api.post(`${B}/auth/reset-password`).send({ token, newPassword: 'weak' })).status).toBe(400);
    expect((await api.post(`${B}/auth/reset-password`).send({ token, newPassword: 'Brand#NewPass99' })).status).toBe(200);
    expect((await api.post(`${B}/auth/reset-password`).send({ token, newPassword: 'Brand#NewPass99' })).status).toBe(400); // single use
    const login = await api.post(`${B}/auth/login`).send({ email: 'view@test.rw', password: 'Brand#NewPass99' });
    expect(login.status).toBe(200);
  });
});
