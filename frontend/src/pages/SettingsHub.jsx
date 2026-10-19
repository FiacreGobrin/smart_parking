import { lazy, Suspense, useMemo, useState } from 'react';
import { PageHeader, Tabs } from '../components/ui/Card.jsx';
import { Spinner } from '../components/ui/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const Resource = (name) => lazy(() => import('./ResourcePages.jsx').then((m) => ({ default: m[name] })));
const System = (name) => lazy(() => import('./SystemPages.jsx').then((m) => ({ default: m[name] })));
const SpaceMap = lazy(() => import('./SpaceMap.jsx'));

// Everything an administrator configures that is not part of the daily screens lives here.
const TABS = [
  { value: 'general', label: 'General', perm: 'settings.read', Page: System('SettingsPage') },
  { value: 'facilities', label: 'Facilities', perm: 'facilities.read', Page: Resource('FacilitiesPage') },
  { value: 'spaces', label: 'Spaces', perm: 'spaces.read', Page: SpaceMap },
  { value: 'gates', label: 'Gates', perm: 'gates.read', Page: Resource('GatesPage') },
  { value: 'cameras', label: 'Cameras', perm: 'cameras.read', Page: Resource('CamerasPage') },
  { value: 'audit', label: 'Audit log', perm: 'audit.read', Page: System('AuditPage') },
  { value: 'notifications', label: 'Notifications', perm: 'notifications.read', Page: System('NotificationsPage') },
];

export default function SettingsHub() {
  const { can } = useAuth();
  const tabs = useMemo(() => TABS.filter((t) => can(t.perm)), [can]);
  const [tab, setTab] = useState(() => tabs[0]?.value);
  const active = tabs.find((t) => t.value === tab) || tabs[0];
  return (
    <>
      <PageHeader title="Settings" description="Facilities, spaces, devices, audit log and system options." />
      <Tabs tabs={tabs} value={active?.value} onChange={setTab} />
      <Suspense fallback={<Spinner />}>{active && <active.Page key={active.value} />}</Suspense>
    </>
  );
}
