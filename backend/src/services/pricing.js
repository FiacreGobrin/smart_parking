import Decimal from 'decimal.js';

const D = (v) => new Decimal(v ?? 0);

export const UNIT_MINUTES = { HOUR: 60, DAY: 1440, WEEK: 10080, MONTH: 43200 };
export const MIN_START_PRICE = 100;

// Most specific active tariff wins: facility+vehicle type > facility > vehicle type > global.
// A tariff is only used from its "effective from" date.
export function pickRate(rates, { facilityId, vehicleType, service = 'PARKING', unit = 'HOUR', at = new Date() }) {
  const candidates = rates.filter((r) => {
    if (!r.isActive) return false;
    if (r.service !== service || r.unit !== unit) return false;
    if (r.validFrom && new Date(r.validFrom) > at) return false;
    if (r.validTo && new Date(r.validTo) < at) return false;
    if (r.facilityId && r.facilityId !== facilityId) return false;
    if (r.vehicleType && r.vehicleType !== vehicleType) return false;
    return true;
  });
  const score = (r) => (r.facilityId ? 2 : 0) + (r.vehicleType ? 1 : 0);
  const time = (r) => new Date(r.validFrom || r.updatedAt || 0).getTime();
  return candidates.sort((a, b) => score(b) - score(a) || time(b) - time(a))[0] || null;
}

/** Number of billing units started for a stay (always at least 1; a visit is always 1). */
export function unitsStarted(minutes, unit) {
  if (unit === 'VISIT') return 1;
  return Math.max(1, Math.ceil(minutes / UNIT_MINUTES[unit]));
}

/**
 * Fee for a stay. Formula (from the approved design):
 *   price = start price + (units started - 1) x increase, never above the cap.
 * For hourly tariffs the cap is a DAILY cap: every full 24 h costs the cap, the rest follows the formula.
 * Pure: no database, no clock. Decimal arithmetic throughout.
 */
export function calculateFee({
  entryAt, exitAt, rate, taxRate = 0, discountPercent = 0, discountFixed = 0, exempt = false, exemptReason = null,
}) {
  const ms = new Date(exitAt) - new Date(entryAt);
  const durationMinutes = Math.max(0, Math.ceil(ms / 60000));
  const zero = D(0);
  const base = { durationMinutes, rateId: rate?.id ?? null, exempt, exemptReason };

  if (exempt) {
    return { ...base, units: 0, subtotal: zero, discount: zero, tax: zero, total: zero, lines: [{ label: `Exempt${exemptReason ? `: ${exemptReason}` : ''}`, amount: zero }] };
  }
  if (!rate) throw new Error('No active price applies to this service, vehicle type and billing unit');

  const unit = rate.unit || 'HOUR';
  const start = D(rate.startPrice);
  const inc = D(rate.increment);
  const cap = rate.cap != null ? D(rate.cap) : null;
  const unitName = unit === 'VISIT' ? 'visit' : unit.toLowerCase();
  const formula = (n) => start.plus(inc.mul(n - 1));

  const lines = [];
  let subtotal;
  let units;

  if (unit === 'HOUR' && cap) {
    const days = Math.floor(durationMinutes / 1440);
    const remMinutes = durationMinutes - days * 1440;
    const remUnits = remMinutes > 0 || days === 0 ? unitsStarted(remMinutes, 'HOUR') : 0;
    units = days * 24 + remUnits;
    subtotal = zero;
    if (days > 0) {
      subtotal = subtotal.plus(cap.mul(days));
      lines.push({ label: `${days} full day(s) at the daily cap of ${cap.toFixed(0)}`, amount: cap.mul(days) });
    }
    if (remUnits > 0) {
      let amt = formula(remUnits);
      let label = remUnits === 1 ? `Start price ${start.toFixed(0)}` : `Start price ${start.toFixed(0)} + ${remUnits - 1} x ${inc.toFixed(0)}`;
      if (amt.gt(cap)) { amt = cap; label += ` (limited to the daily cap ${cap.toFixed(0)})`; }
      subtotal = subtotal.plus(amt);
      lines.push({ label: `${remUnits} ${unitName}(s) started: ${label}`, amount: amt });
    }
  } else {
    units = unitsStarted(durationMinutes, unit);
    subtotal = formula(units);
    let label = units === 1 ? `Start price ${start.toFixed(0)}` : `Start price ${start.toFixed(0)} + ${units - 1} x ${inc.toFixed(0)}`;
    if (cap && subtotal.gt(cap)) { subtotal = cap; label += ` (limited to the cap ${cap.toFixed(0)})`; }
    lines.push({ label: unit === 'VISIT' ? label : `${units} ${unitName}(s) started: ${label}`, amount: subtotal });
  }

  let discount = subtotal.mul(D(discountPercent)).div(100).plus(D(discountFixed));
  if (discount.gt(subtotal)) discount = subtotal;
  discount = discount.toDecimalPlaces(2);
  if (discount.gt(0)) lines.push({ label: 'Discount', amount: discount.neg() });

  const taxable = subtotal.minus(discount);
  const tax = taxable.mul(D(taxRate)).div(100);
  // RWF has no minor unit: the amount charged is a whole number of francs.
  const total = taxable.plus(tax).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const taxShown = total.minus(taxable);
  if (D(taxRate).gt(0)) lines.push({ label: `Tax (${D(taxRate).toString()}%)`, amount: taxShown });

  return { ...base, units, subtotal, discount, tax: taxShown, total, lines };
}

export const serializeFee = (fee) => ({
  durationMinutes: fee.durationMinutes,
  units: fee.units,
  rateId: fee.rateId,
  exempt: fee.exempt,
  exemptReason: fee.exemptReason,
  subtotal: fee.subtotal.toFixed(2),
  discount: fee.discount.toFixed(2),
  tax: fee.tax.toFixed(2),
  total: fee.total.toFixed(2),
  lines: fee.lines.map((l) => ({ label: l.label, amount: l.amount.toFixed(2) })),
});
