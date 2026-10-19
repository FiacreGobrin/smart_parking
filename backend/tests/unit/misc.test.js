import { describe, expect, it } from 'vitest';
import { PERMISSIONS, can } from '../../src/config/permissions.js';
import { sign, verifySignature } from '../../src/integrations/payments/index.js';
import { toCsv } from '../../src/utils/csv.js';
import { startOfToday } from '../../src/utils/dates.js';

describe('role permissions', () => {
  it('super admin can do everything', () => {
    expect(can('SUPER_ADMIN', 'anything.at.all')).toBe(true);
  });
  it('attendants can process payments but not refund, export or read audit logs', () => {
    expect(can('ATTENDANT', 'payments.create')).toBe(true);
    expect(can('ATTENDANT', 'payments.refund')).toBe(false);
    expect(can('ATTENDANT', 'export')).toBe(false);
    expect(can('ATTENDANT', 'audit.read')).toBe(false);
  });
  it('finance officers can refund and see finance reports but cannot touch gates or entries', () => {
    expect(can('FINANCE_OFFICER', 'payments.refund')).toBe(true);
    expect(can('FINANCE_OFFICER', 'reports.finance')).toBe(true);
    expect(can('FINANCE_OFFICER', 'gates.command')).toBe(false);
    expect(can('FINANCE_OFFICER', 'sessions.write')).toBe(false);
  });
  it('viewers are strictly read-only and see no personal or financial data', () => {
    const writes = PERMISSIONS.VIEWER.filter((p) => /write|create|refund|command|exempt/.test(p));
    expect(writes).toEqual([]);
    expect(can('VIEWER', 'reports.finance')).toBe(false);
    expect(can('VIEWER', 'vehicles.read')).toBe(false);
  });
  it('unknown roles have no permissions', () => {
    expect(can('HACKER', 'dashboard.read')).toBe(false);
  });
});

describe('webhook signatures', () => {
  const body = Buffer.from('{"eventId":"1","status":"SUCCESS"}');
  it('accepts a correct HMAC and rejects tampering', () => {
    const sig = sign(body, 'secret');
    expect(verifySignature(body, sig, 'secret')).toBe(true);
    expect(verifySignature(Buffer.from('{"eventId":"1","status":"FAILED"}'), sig, 'secret')).toBe(false);
    expect(verifySignature(body, sig, 'other-secret')).toBe(false);
  });
  it('rejects missing or malformed signatures without throwing', () => {
    expect(verifySignature(body, undefined, 'secret')).toBe(false);
    expect(verifySignature(body, 'not-hex', 'secret')).toBe(false);
    expect(verifySignature(body, sign(body, 'secret'), null)).toBe(false);
  });
});

describe('csv export', () => {
  it('quotes special characters and neutralizes spreadsheet formulas', () => {
    const csv = toCsv([{ a: 'x,y', b: '=HYPERLINK("evil")', c: 'line\nbreak' }], ['a', 'b', 'c']);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(csv).toContain('"line\nbreak"');
  });
});

describe('Kigali day boundary', () => {
  it('starts the day at 22:00 UTC of the previous day (UTC+2)', () => {
    const start = startOfToday(new Date('2026-03-10T23:30:00Z')); // 01:30 on 11 March in Kigali
    expect(start.toISOString()).toBe('2026-03-10T22:00:00.000Z');
  });
});
