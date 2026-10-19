import { useState } from 'react';
import { z } from 'zod';
import { Activity, DoorOpen, Wifi } from 'lucide-react';
import ResourcePage, { cleanPayload } from '../components/ResourcePage.jsx';
import { Button, IconButton } from '../components/ui/Button.jsx';
import { Badge, SimulatedBadge, StatusBadge } from '../components/ui/Badge.jsx';
import { Tabs } from '../components/ui/Card.jsx';
import { DataTable } from '../components/ui/DataTable.jsx';
import { Modal } from '../components/ui/Modal.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { get, parseError, post } from '../services/api.js';
import { dateTime, displayPlate, titleCase } from '../utils/format.js';
import { zNum, zOptStr, zStr } from '../utils/zod.js';

const opts = (arr) => arr.map((v) => ({ value: v, label: titleCase(v) }));
const DEVICE_STATUS = opts(['ONLINE', 'OFFLINE', 'MAINTENANCE', 'ERROR']);
const facilityOptions = { endpoint: '/facilities', label: 'name' };

// ---------------------------------------------------------------- Facilities & zones
const facilityConfig = {
  title: 'Parking Facilities', description: 'Locations you operate. Each facility has its own spaces, gates, tariffs and staff.',
  endpoint: '/facilities', singular: 'Facility', writePermission: 'facilities.write', searchPlaceholder: 'Search name, code or city...',
  defaultSort: { sortBy: 'name', order: 'asc' },
  columns: [
    { key: 'code', label: 'Code', sortable: true, render: (r) => <span className="font-mono text-xs">{r.code}</span> },
    { key: 'name', label: 'Name', sortable: true, render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'city', label: 'City' },
    { key: 'currency', label: 'Currency' },
    { key: 'taxRate', label: 'Tax', render: (r) => `${Number(r.taxRate)}%` },
    { key: 'isActive', label: 'Status', render: (r) => <StatusBadge status={r.isActive ? 'ACTIVE' : 'CANCELLED'} /> },
  ],
  fields: [
    { name: 'code', label: 'Code', required: true, help: 'Short unique code, e.g. KCC' },
    { name: 'name', label: 'Name', required: true },
    { name: 'address', label: 'Address' },
    { name: 'city', label: 'City' },
    { name: 'currency', label: 'Currency (ISO)', required: true },
    { name: 'taxRate', label: 'Tax rate (%)', type: 'number', help: 'Added on top of fees. 0 for none.' },
    { name: 'lowAvailabilityThreshold', label: 'Low-availability alert (% free)', type: 'number', help: 'An alert is raised at or below this percentage of free spaces.' },
    { name: 'allowUnassignedSpace', type: 'checkbox', label: 'Allow entry without a numbered space', wide: true },
    { name: 'isActive', type: 'checkbox', label: 'Facility is active', wide: true },
  ],
  schema: z.object({
    code: zStr('Code', 2, 20), name: zStr('Name', 2, 120), address: zOptStr(), city: zOptStr(80),
    currency: zStr('Currency', 3, 3), taxRate: zNum('Tax rate', { max: 100 }), lowAvailabilityThreshold: zNum('Threshold', { max: 100 }),
    allowUnassignedSpace: z.boolean(), isActive: z.boolean(),
  }),
  defaults: { code: '', name: '', address: '', city: 'Kigali', currency: 'RWF', taxRate: 0, lowAvailabilityThreshold: 10, allowUnassignedSpace: false, isActive: true },
  toForm: (r) => ({ ...r, address: r.address ?? '', city: r.city ?? '', taxRate: Number(r.taxRate) }),
  deleteMessage: (r) => `"${r.name}" will be archived. This is refused while vehicles are still parked there.`,
};

const zoneConfig = {
  title: 'Zones, floors and sections', description: 'Group spaces by floor or area.', endpoint: '/zones', singular: 'Zone', writePermission: 'zones.write',
  facilityFilter: true, searchPlaceholder: 'Search zones...',
  columns: [
    { key: 'name', label: 'Zone', sortable: true, render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'floor', label: 'Floor' }, { key: 'section', label: 'Section' },
    { key: 'spaces', label: 'Spaces', render: (r) => r._count?.spaces ?? 0 },
  ],
  fields: [
    { name: 'facilityId', label: 'Facility', type: 'select', required: true, optionsFrom: facilityOptions },
    { name: 'name', label: 'Zone name', required: true },
    { name: 'floor', label: 'Floor' }, { name: 'section', label: 'Section' },
  ],
  schema: z.object({ facilityId: zStr('Facility'), name: zStr('Zone name', 1, 60), floor: zOptStr(30), section: zOptStr(30) }),
  defaults: { facilityId: '', name: '', floor: '', section: '' },
  toForm: (r) => ({ ...r, floor: r.floor ?? '', section: r.section ?? '' }),
  deleteMessage: () => 'Only empty zones can be deleted.',
};

export function FacilitiesPage() {
  const [tab, setTab] = useState('facilities');
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'facilities', label: 'Facilities' }, { value: 'zones', label: 'Zones & floors' }]} />
      {tab === 'facilities' ? <ResourcePage key="f" config={facilityConfig} /> : <ResourcePage key="z" config={zoneConfig} />}
    </>
  );
}

// ---------------------------------------------------------------- Gates
function GateEventsModal({ gate, onClose }) {
  const [page, setPage] = useState(1);
  const { data, meta, loading, error, reload } = useFetch(() => get(`/gates/${gate.id}/events`, { page, limit: 10 }), [gate.id, page]);
  return (
    <Modal open onClose={onClose} title={`Event history: ${gate.name}`} size="xl">
      <DataTable loading={loading} error={error} onRetry={reload} rows={data} meta={meta} onPage={setPage} dense
        columns={[
          { key: 'createdAt', label: 'Time', render: (r) => dateTime(r.createdAt) },
          { key: 'type', label: 'Event', render: (r) => titleCase(r.type) },
          { key: 'outcome', label: 'Outcome', render: (r) => <StatusBadge status={r.outcome} /> },
          { key: 'plate', label: 'Plate', render: (r) => (r.plate ? displayPlate(r.plate) : '-') },
          { key: 'reason', label: 'Detail', render: (r) => <span className="text-muted">{r.reason || r.details?.detail || '-'}{r.details?.simulated ? ' (simulated)' : ''}</span> },
        ]} />
    </Modal>
  );
}

export function GatesPage() {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const [eventsFor, setEventsFor] = useState(null);
  const [busy, setBusy] = useState(null);

  const run = async (gate, kind, reload) => {
    if (kind === 'OPEN') {
      const ok = await confirm({ title: 'Open gate?', message: `Send an OPEN command to "${gate.name}". The result recorded is the controller's real acknowledgement.`, confirmLabel: 'Send command' });
      if (!ok) return;
    }
    setBusy(`${gate.id}:${kind}`);
    try {
      const { data } = kind === 'PING' ? await post(`/gates/${gate.id}/ping`) : await post(`/gates/${gate.id}/commands`, { command: kind });
      if (kind === 'PING') toast(`${gate.name}: ${data.online ? 'controller responded' : 'no response'} (${data.detail})`, data.online ? 'success' : 'error');
      else toast(`${data.acknowledged ? 'Acknowledged' : 'NOT acknowledged'}: ${data.detail}`, data.acknowledged ? 'success' : 'error');
      reload();
    } catch (err) {
      toast(parseError(err).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <ResourcePage config={{
        title: 'Gates & Controllers', description: 'Entry and exit barriers. Commands succeed only when the controller acknowledges them; SIMULATION controllers move no hardware.',
        endpoint: '/gates', singular: 'Gate', writePermission: 'gates.write', facilityFilter: true, searchPlaceholder: 'Search gates...',
        filters: [{ key: 'status', label: 'All statuses', options: DEVICE_STATUS }, { key: 'direction', label: 'Both directions', options: opts(['ENTRY', 'EXIT']) }],
        columns: [
          { key: 'name', label: 'Gate', sortable: true, render: (r) => <span className="font-medium text-ink">{r.name}</span> },
          { key: 'direction', label: 'Direction', render: (r) => <Badge tone={r.direction === 'ENTRY' ? 'teal' : 'amber'}>{titleCase(r.direction)}</Badge> },
          { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusBadge status={r.status} /> },
          { key: 'controllerType', label: 'Controller', render: (r) => (r.controllerType === 'SIMULATION' ? <SimulatedBadge /> : <span className="text-xs">HTTP</span>) },
          { key: 'lastHeartbeatAt', label: 'Last response', render: (r) => dateTime(r.lastHeartbeatAt) },
        ],
        rowActions: (r, reload) => (can('gates.command') ? (
          <>
            <IconButton icon={Wifi} label="Test connection" disabled={busy === `${r.id}:PING`} onClick={() => run(r, 'PING', reload)} />
            <IconButton icon={DoorOpen} label="Open gate" disabled={busy === `${r.id}:OPEN`} onClick={() => run(r, 'OPEN', reload)} />
            <IconButton icon={Activity} label="Event history" onClick={() => setEventsFor(r)} />
          </>
        ) : <IconButton icon={Activity} label="Event history" onClick={() => setEventsFor(r)} />),
        fields: [
          { name: 'facilityId', label: 'Facility', type: 'select', required: true, optionsFrom: facilityOptions },
          { name: 'name', label: 'Gate name', required: true },
          { name: 'direction', label: 'Direction', type: 'select', required: true, options: opts(['ENTRY', 'EXIT']) },
          { name: 'status', label: 'Status', type: 'select', required: true, options: DEVICE_STATUS },
          { name: 'controllerType', label: 'Controller type', type: 'select', required: true, options: [{ value: 'SIMULATION', label: 'Simulation (no hardware)' }, { value: 'HTTP', label: 'HTTP controller' }] },
          { name: 'controllerUrl', label: 'Controller URL', placeholder: 'http://192.168.1.50:8080', show: (v) => v.controllerType === 'HTTP', required: true, help: 'Must answer POST /command with { "ack": true } and GET /health.' },
        ],
        editFields: [
          { name: 'name', label: 'Gate name', required: true },
          { name: 'direction', label: 'Direction', type: 'select', required: true, options: opts(['ENTRY', 'EXIT']) },
          { name: 'status', label: 'Status', type: 'select', required: true, options: DEVICE_STATUS },
          { name: 'controllerType', label: 'Controller type', type: 'select', required: true, options: [{ value: 'SIMULATION', label: 'Simulation (no hardware)' }, { value: 'HTTP', label: 'HTTP controller' }] },
          { name: 'controllerUrl', label: 'Controller URL', show: (v) => v.controllerType === 'HTTP', required: true },
        ],
        schema: z.object({
          facilityId: zStr('Facility'), name: zStr('Gate name', 2, 80), direction: z.enum(['ENTRY', 'EXIT']),
          status: z.enum(['ONLINE', 'OFFLINE', 'MAINTENANCE', 'ERROR']), controllerType: z.enum(['SIMULATION', 'HTTP']), controllerUrl: zOptStr(300),
        }).superRefine((v, ctx) => {
          if (v.controllerType === 'HTTP' && !/^https?:\/\//.test(v.controllerUrl || '')) ctx.addIssue({ code: 'custom', path: ['controllerUrl'], message: 'Enter the controller URL (http:// or https://)' });
        }),
        defaults: { facilityId: '', name: '', direction: 'ENTRY', status: 'ONLINE', controllerType: 'SIMULATION', controllerUrl: '' },
        toForm: (r) => ({ ...r, controllerUrl: r.controllerUrl ?? '' }),
        toPayload: (v, isEdit) => {
          const body = cleanPayload(v, isEdit);
          if (v.controllerType === 'SIMULATION') delete body.controllerUrl;
          if (isEdit) delete body.facilityId;
          return body;
        },
      }} />
      {eventsFor && <GateEventsModal gate={eventsFor} onClose={() => setEventsFor(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- Cameras
export function CamerasPage() {
  return (
    <ResourcePage config={{
      title: 'Cameras', description: 'Capture points feeding plate recognition. Simulated cameras do not produce real images.',
      endpoint: '/cameras', singular: 'Camera', writePermission: 'cameras.write', facilityFilter: true, searchPlaceholder: 'Search cameras...',
      filters: [{ key: 'status', label: 'All statuses', options: DEVICE_STATUS }],
      columns: [
        { key: 'name', label: 'Camera', sortable: true, render: (r) => <span className="font-medium text-ink">{r.name}</span> },
        { key: 'gate', label: 'Gate', render: (r) => r.gate?.name || '-' },
        { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusBadge status={r.status} /> },
        { key: 'isSimulated', label: 'Source', render: (r) => (r.isSimulated ? <SimulatedBadge /> : <Badge tone="teal">Live</Badge>) },
        { key: 'lastSeenAt', label: 'Last capture', render: (r) => dateTime(r.lastSeenAt) },
      ],
      fields: [
        { name: 'facilityId', label: 'Facility', type: 'select', required: true, optionsFrom: facilityOptions },
        { name: 'name', label: 'Camera name', required: true },
        { name: 'gateId', label: 'Linked gate', type: 'select', optionsFrom: { endpoint: '/gates', label: (g) => g.name }, help: 'Recognitions from this camera act on this gate.' },
        { name: 'status', label: 'Status', type: 'select', required: true, options: DEVICE_STATUS },
        { name: 'streamUrl', label: 'Stream URL (optional)', wide: true },
        { name: 'isSimulated', type: 'checkbox', label: 'Simulated camera (no physical device)', wide: true },
      ],
      schema: z.object({ facilityId: zStr('Facility'), name: zStr('Camera name', 2, 80), gateId: zOptStr(), status: z.enum(['ONLINE', 'OFFLINE', 'MAINTENANCE', 'ERROR']), streamUrl: zOptStr(300), isSimulated: z.boolean() }),
      defaults: { facilityId: '', name: '', gateId: '', status: 'ONLINE', streamUrl: '', isSimulated: true },
      toForm: (r) => ({ ...r, gateId: r.gateId ?? '', streamUrl: r.streamUrl ?? '' }),
    }} />
  );
}
