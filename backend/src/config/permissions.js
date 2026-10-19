// Role -> permission map. Enforced by middleware/auth.js#requirePermission on every protected route.
export const PERMISSIONS = {
  SUPER_ADMIN: ['*'],
  // Field users (the people who scan plates and take payments on a phone) and attendants share the same rights.
  USER: null, // filled below
  PARKING_ADMIN: [
    'dashboard.read', 'facilities.read', 'facilities.write', 'zones.write', 'spaces.read', 'spaces.write',
    'vehicles.read', 'vehicles.write', 'sessions.read', 'sessions.write', 'sessions.exempt',
    'gates.read', 'gates.write', 'gates.command', 'cameras.read', 'cameras.write',
    'anpr.use', 'anpr.read', 'pricing.read', 'payments.read', 'payments.create', 'receipts.read',
    'reservations.read', 'reservations.write', 'permits.read', 'permits.write',
    'reports.read', 'reports.finance', 'export', 'notifications.read',
    'users.read', 'users.write.staff', 'audit.read',
  ],
  ATTENDANT: [
    'dashboard.read', 'facilities.read', 'spaces.read', 'vehicles.read', 'vehicles.write',
    'sessions.read', 'sessions.write', 'gates.read', 'gates.command', 'cameras.read',
    'anpr.use', 'anpr.read', 'pricing.read', 'payments.read', 'payments.create', 'receipts.read',
    'reservations.read', 'reservations.write', 'permits.read', 'notifications.read',
  ],
  FINANCE_OFFICER: [
    'dashboard.read', 'facilities.read', 'sessions.read', 'pricing.read',
    'payments.read', 'payments.refund', 'payments.reconcile', 'receipts.read',
    'reports.read', 'reports.finance', 'export', 'permits.read', 'reservations.read', 'notifications.read',
  ],
  VIEWER: [
    'dashboard.read', 'facilities.read', 'spaces.read', 'sessions.read',
    'reports.read', 'notifications.read',
  ],
};

PERMISSIONS.USER = [...PERMISSIONS.ATTENDANT];

export function can(role, permission) {
  const list = PERMISSIONS[role] || [];
  return list.includes('*') || list.includes(permission);
}

export function permissionsFor(role) {
  return PERMISSIONS[role] || [];
}
