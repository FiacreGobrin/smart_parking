import { describe, expect, it } from 'vitest';
import { calculateFee, pickRate, unitsStarted } from '../../src/services/pricing.js';

const at = (min) => new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + min * 60000);
// The example from the approved design: start 100, +100 per extra hour, daily cap 2000.
const car = { id: 'car', service: 'PARKING', unit: 'HOUR', isActive: true, startPrice: 100, increment: 100, cap: 2000 };
const fee = (minutes, rate = car, extra = {}) => calculateFee({ entryAt: at(0), exitAt: at(minutes), rate, ...extra });

describe('calculateFee (start price + (units started - 1) x increase, capped)', () => {
  it('matches the design example: 3 h 15 min = 4 hours started = 100 + 3 x 100 = 400', () => {
    const f = fee(3 * 60 + 15);
    expect(f.units).toBe(4);
    expect(f.total.toNumber()).toBe(400);
    expect(f.lines[0].label).toContain('100 + 3 x 100');
  });

  it('charges the start price even for a very short stay', () => {
    expect(fee(0).total.toNumber()).toBe(100);
    expect(fee(1).total.toNumber()).toBe(100);
    expect(fee(60).total.toNumber()).toBe(100);
  });

  it('starts a new hour as soon as the previous one is exceeded', () => {
    expect(fee(61).total.toNumber()).toBe(200);
    expect(fee(120).total.toNumber()).toBe(200);
    expect(fee(121).total.toNumber()).toBe(300);
  });

  it('never goes above the daily cap', () => {
    expect(fee(20 * 60).total.toNumber()).toBe(2000); // 100 + 19 x 100 = 2000 exactly
    expect(fee(23 * 60).total.toNumber()).toBe(2000); // would be 2300
    expect(fee(23 * 60).lines[0].label).toMatch(/daily cap/i);
  });

  it('charges the daily cap for every full 24 hours, then the formula for the rest', () => {
    expect(fee(1440).total.toNumber()).toBe(2000);
    expect(fee(1440 + 90).total.toNumber()).toBe(2000 + 200); // 1 day + 2 hours started
    expect(fee(2 * 1440 + 30).total.toNumber()).toBe(4000 + 100);
  });

  it('works without a cap', () => {
    const noCap = { ...car, cap: null };
    expect(fee(30 * 60, noCap).total.toNumber()).toBe(100 + 29 * 100);
  });

  it('supports motorbike pricing with a smaller increase', () => {
    const bike = { ...car, increment: 50, cap: 1000 };
    expect(fee(3 * 60 + 15, bike).total.toNumber()).toBe(100 + 3 * 50);
  });

  it('bills garage stays per day, week or month with the start price and optional increase', () => {
    const day = { service: 'GARAGE', unit: 'DAY', startPrice: 1500, increment: 0, cap: 1500 };
    expect(fee(10 * 60, day).total.toNumber()).toBe(1500);
    expect(fee(3 * 1440, day).total.toNumber()).toBe(1500); // capped
    const dayInc = { ...day, increment: 1000, cap: null };
    expect(fee(2 * 1440 + 1, dayInc).total.toNumber()).toBe(1500 + 2 * 1000); // 3 days started
    const month = { service: 'GARAGE', unit: 'MONTH', startPrice: 25000, increment: 0, cap: 25000 };
    expect(fee(20 * 1440, month).total.toNumber()).toBe(25000);
  });

  it('charges car wash per visit regardless of duration', () => {
    const wash = { service: 'CAR_WASH', unit: 'VISIT', startPrice: 2000, increment: 0, cap: 4000 };
    expect(fee(10, wash).total.toNumber()).toBe(2000);
    expect(fee(300, wash).total.toNumber()).toBe(2000);
  });

  it('applies percentage and fixed discounts but never below zero', () => {
    expect(fee(125, car, { discountPercent: 50 }).total.toNumber()).toBe(150);
    expect(fee(125, car, { discountFixed: 100 }).total.toNumber()).toBe(200);
    expect(fee(125, car, { discountFixed: 99999 }).total.toNumber()).toBe(0);
  });

  it('adds tax and rounds to whole francs while keeping the lines consistent', () => {
    const f = fee(125, car, { taxRate: 18 }); // 300 * 1.18 = 354
    expect(f.total.toNumber()).toBe(354);
    expect(f.subtotal.minus(f.discount).plus(f.tax).toNumber()).toBe(f.total.toNumber());
  });

  it('honours exemptions with a recorded reason', () => {
    const f = fee(600, car, { exempt: true, exemptReason: 'Staff vehicle' });
    expect(f.total.toNumber()).toBe(0);
    expect(f.lines[0].label).toContain('Staff vehicle');
  });

  it('uses exact decimal arithmetic', () => {
    const r = { ...car, startPrice: 0.1, increment: 0.1, cap: null };
    expect(fee(180, r).total.toNumber()).toBe(0); // whole-franc rounding
    const fr = calculateFee({ entryAt: at(0), exitAt: at(180), rate: { ...r, startPrice: 100.1, increment: 100.1 } });
    expect(fr.subtotal.toString()).toBe('300.3');
  });

  it('refuses to guess a price when no tariff exists', () => {
    expect(() => calculateFee({ entryAt: at(0), exitAt: at(120), rate: null })).toThrow(/price/i);
  });
});

describe('unitsStarted', () => {
  it('counts started units, minimum one', () => {
    expect(unitsStarted(0, 'HOUR')).toBe(1);
    expect(unitsStarted(61, 'HOUR')).toBe(2);
    expect(unitsStarted(1441, 'DAY')).toBe(2);
    expect(unitsStarted(99999, 'VISIT')).toBe(1);
  });
});

describe('pickRate', () => {
  const base = { isActive: true, service: 'PARKING', unit: 'HOUR', startPrice: 100 };
  const rates = [
    { ...base, id: 'global' },
    { ...base, id: 'car', vehicleType: 'CAR' },
    { ...base, id: 'fac', facilityId: 'F1' },
    { ...base, id: 'fac-car', facilityId: 'F1', vehicleType: 'CAR' },
    { ...base, id: 'inactive', facilityId: 'F1', vehicleType: 'CAR', isActive: false },
    { ...base, id: 'garage', service: 'GARAGE', unit: 'DAY' },
  ];
  it('prefers the most specific active price', () => {
    expect(pickRate(rates, { facilityId: 'F1', vehicleType: 'CAR' }).id).toBe('fac-car');
    expect(pickRate(rates, { facilityId: 'F1', vehicleType: 'BUS' }).id).toBe('fac');
    expect(pickRate(rates, { facilityId: 'F2', vehicleType: 'CAR' }).id).toBe('car');
    expect(pickRate(rates, { facilityId: 'F2', vehicleType: 'BUS' }).id).toBe('global');
  });
  it('matches service and billing unit', () => {
    expect(pickRate(rates, { facilityId: 'F1', vehicleType: 'CAR', service: 'GARAGE', unit: 'DAY' }).id).toBe('garage');
    expect(pickRate(rates, { facilityId: 'F1', vehicleType: 'CAR', service: 'CAR_WASH', unit: 'VISIT' })).toBeNull();
  });
  it('ignores prices that are not effective yet', () => {
    const future = [{ ...base, id: 'x', validFrom: new Date(Date.now() + 86400000) }];
    expect(pickRate(future, { facilityId: 'F1', vehicleType: 'CAR' })).toBeNull();
  });
});
