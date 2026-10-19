import { prisma } from '../config/db.js';
import { DEFAULT_PLATE_FORMATS } from '../utils/plate.js';

// Defaults used until an administrator saves a value.
export const SETTING_DEFAULTS = {
  'plate.formats': { value: DEFAULT_PLATE_FORMATS, description: 'Known license plate patterns (regex on the normalized plate). Unmatched plates are still accepted but flagged.' },
  'access.allowUnregistered': { value: true, description: 'Allow vehicles that are not in the registry to enter as visitors.' },
  'anpr.minConfidence': { value: 0.85, description: 'Below this confidence the operator must confirm the plate.' },
  'org.name': { value: 'Smart Parking Rwanda', description: 'Name printed on receipts.' },
  'org.receiptFooter': { value: 'Thank you for parking with us.', description: 'Footer line printed on receipts.' },
  'telephone.sms_sender': { value: 'SmartParking', description: 'Sender name shown on SMS messages.' },
  'telephone.support_line': { value: '', description: 'Support phone number printed on receipts and sent in SMS.' },
  'telephone.mtn_momo': { value: '', description: 'MTN MoMo merchant number or code.' },
  'telephone.airtel_money': { value: '', description: 'Airtel Money merchant number or code.' },
  'telephone.equity_bank': { value: '', description: 'Equity Bank collection account or short code.' },
  'permit.expiryWarningDays': { value: 7, description: 'Days before expiry to warn about permits.' },
  'reservation.noShowGraceMinutes': { value: 30, description: 'Minutes after the start time before a reservation is marked no-show.' },
};

export async function getSetting(key) {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row ? row.value : SETTING_DEFAULTS[key]?.value;
}

export async function getAllSettings() {
  const rows = await prisma.systemSetting.findMany();
  const map = new Map(rows.map((r) => [r.key, r]));
  const keys = new Set([...Object.keys(SETTING_DEFAULTS), ...map.keys()]);
  return [...keys].sort().map((key) => ({
    key,
    value: map.has(key) ? map.get(key).value : SETTING_DEFAULTS[key].value,
    description: map.get(key)?.description ?? SETTING_DEFAULTS[key]?.description ?? null,
    isDefault: !map.has(key),
    updatedAt: map.get(key)?.updatedAt ?? null,
  }));
}

export async function setSetting(key, value, userId) {
  return prisma.systemSetting.upsert({
    where: { key },
    update: { value, updatedById: userId },
    create: { key, value, updatedById: userId, description: SETTING_DEFAULTS[key]?.description },
  });
}
