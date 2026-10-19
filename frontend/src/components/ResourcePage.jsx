import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { useFetch } from '../hooks/useFetch.js';
import { del, get, parseError, patch, post } from '../services/api.js';
import { Button, IconButton } from './ui/Button.jsx';
import { Card, PageHeader } from './ui/Card.jsx';
import { DataTable } from './ui/DataTable.jsx';
import { FacilityFilter, FilterBar, FilterSelect, SearchBox } from './ui/Filters.jsx';
import { Modal } from './ui/Modal.jsx';
import { ResourceForm } from './ResourceForm.jsx';

/**
 * Config-driven list + create/edit/delete page used by facilities, vehicles, gates, cameras, tariffs, users...
 *
 * config: { title, description, endpoint, singular, columns, fields, schema, writePermission,
 *           filters: [{key,label,options}], facilityFilter, searchPlaceholder, defaults,
 *           toForm(row) -> form values, toPayload(values, isEdit) -> request body, canEditRow(row), canDeleteRow(row),
 *           deleteMessage(row), rowActions(row, reload), extraActions, defaultSort, onRowClick, modalSize }
 */
export default function ResourcePage({ config }) {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const [urlParams] = useSearchParams();
  const [query, setQuery] = useState({ page: 1, search: urlParams.get('search') || '', ...(config.defaultSort || {}) });
  const [editing, setEditing] = useState(null); // null | 'new' | row

  const params = useMemo(() => Object.fromEntries(Object.entries({ ...query, limit: 15 }).filter(([, v]) => v !== '' && v != null)), [query]);
  const { data, meta, loading, error, reload } = useFetch(() => get(config.endpoint, params), [JSON.stringify(params)]);

  const set = (patchObj) => setQuery((q) => ({ ...q, page: 1, ...patchObj }));
  const writable = !config.writePermission || can(config.writePermission);

  const onSort = (key) => set({ sortBy: key, order: query.sortBy === key && query.order === 'asc' ? 'desc' : 'asc' });

  const save = useCallback(async (values) => {
    const isEdit = editing && editing !== 'new';
    const body = config.toPayload ? config.toPayload(values, isEdit) : cleanPayload(values, isEdit);
    if (isEdit) await patch(`${config.endpoint}/${editing.id}`, body);
    else await post(config.endpoint, body);
    toast(`${config.singular} ${isEdit ? 'updated' : 'created'}`);
    setEditing(null);
    reload();
  }, [editing, config, toast, reload]);

  const remove = async (row) => {
    const ok = await confirm({
      title: `Delete ${config.singular.toLowerCase()}?`,
      message: config.deleteMessage?.(row) || 'This action is recorded in the audit log.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await del(`${config.endpoint}/${row.id}`);
      toast(`${config.singular} deleted`);
      reload();
    } catch (err) {
      toast(parseError(err).message, 'error');
    }
  };

  const columns = [
    ...config.columns,
    ...(writable || config.rowActions ? [{
      key: '_actions', label: <span className="sr-only">Actions</span>, align: 'right',
      render: (row) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {config.rowActions?.(row, reload)}
          {writable && (config.canEditRow?.(row) ?? true) && <IconButton icon={Pencil} label={`Edit ${config.singular.toLowerCase()}`} onClick={() => setEditing(row)} />}
          {writable && !config.noDelete && (config.canDeleteRow?.(row) ?? true) && <IconButton icon={Trash2} label={`Delete ${config.singular.toLowerCase()}`} onClick={() => remove(row)} className="hover:text-danger" />}
        </div>
      ),
    }] : []),
  ];

  const isEdit = editing && editing !== 'new';
  const fields = isEdit && config.editFields ? config.editFields : config.fields;

  return (
    <>
      <PageHeader title={config.title} description={config.description}
        actions={<>
          {config.extraActions}
          {writable && !config.noCreate && <Button icon={Plus} onClick={() => setEditing('new')}>Add {config.singular.toLowerCase()}</Button>}
        </>} />
      <Card padded={false}>
        <FilterBar>
          <SearchBox value={query.search} onChange={(search) => set({ search })} placeholder={config.searchPlaceholder || 'Search...'} className="min-w-[220px] flex-1 sm:max-w-xs" />
          {config.facilityFilter && <FacilityFilter value={query.facilityId} onChange={(facilityId) => set({ facilityId })} />}
          {(config.filters || []).map((f) => (
            <FilterSelect key={f.key} label={f.label} value={query[f.key]} onChange={(v) => set({ [f.key]: v })} placeholder={f.label} options={f.options} />
          ))}
        </FilterBar>
        <DataTable columns={columns} rows={data} loading={loading} error={error} onRetry={reload} meta={meta}
          onPage={(page) => setQuery((q) => ({ ...q, page }))} sort={query} onSort={onSort} onRowClick={config.onRowClick} />
      </Card>

      <Modal open={!!editing} onClose={() => setEditing(null)} size={config.modalSize || 'md'}
        title={`${isEdit ? 'Edit' : 'Add'} ${config.singular.toLowerCase()}`}
        footer={<>
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button type="submit" form="resource-form">Save</Button>
        </>}>
        {editing && (
          <ResourceForm formId="resource-form" fields={fields} schema={isEdit && config.editSchema ? config.editSchema : config.schema}
            defaults={isEdit ? (config.toForm ? config.toForm(editing) : editing) : config.defaults} onSubmit={save} />
        )}
      </Modal>
    </>
  );
}

// Default conversion: "" becomes omitted when creating and null when editing (clears the value).
export function cleanPayload(values, isEdit) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === '' || v === undefined || (typeof v === 'number' && Number.isNaN(v))) {
      if (isEdit) out[k] = null;
    } else out[k] = v;
  }
  return out;
}
