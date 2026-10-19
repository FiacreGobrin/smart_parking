// The sidebar from the approved design. `perm` is any-of; items a role cannot use are hidden
// (the server enforces the same rules on every request).
export const NAV_ITEMS = [
  { to: '/', title: 'Dashboard', perm: 'dashboard.read', end: true },
  { to: '/users', title: 'Users (CRUD)', perm: 'users.read' },
  { to: '/prices', title: 'Price / Cost (CRUD)', perm: 'pricing.read' },
  { to: '/operations', title: 'Operations', perm: ['sessions.write', 'sessions.read'] },
  { to: '/process', title: 'Business Process', perm: 'dashboard.read' },
  { to: '/statistics', title: 'Statistics', perm: 'reports.read' },
  { to: '/finance', title: 'Finance', perm: 'payments.read' },
  { to: '/telephone', title: 'System Telephone', perm: ['settings.read', 'users.read'] },
  { to: '/settings', title: 'Settings', perm: ['settings.read', 'facilities.read', 'audit.read'] },
];

export const EXTRA_TITLES = {
  '/profile': 'My Profile',
  '/forbidden': 'Access denied',
};

export function titleFor(pathname) {
  if (EXTRA_TITLES[pathname]) return EXTRA_TITLES[pathname];
  const hit = [...NAV_ITEMS].sort((a, b) => b.to.length - a.to.length).find((i) => (i.end ? pathname === i.to : pathname.startsWith(i.to)));
  return hit?.title || 'Smart Parking';
}
