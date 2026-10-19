import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Select } from './Fields.jsx';
import { get } from '../../services/api.js';

export function SearchBox({ value, onChange, placeholder = 'Search...', className = '' }) {
  const [local, setLocal] = useState(value ?? '');
  useEffect(() => setLocal(value ?? ''), [value]);
  // Debounce typing so every keystroke is not a request.
  useEffect(() => {
    if (local === (value ?? '')) return undefined;
    const t = setTimeout(() => onChange(local), 350);
    return () => clearTimeout(t);
  }, [local]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <input type="search" value={local} onChange={(e) => setLocal(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-muted/70" />
    </div>
  );
}

export function FilterSelect({ label, value, onChange, options, placeholder = 'All' }) {
  return (
    <Select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} options={options} className="min-w-[140px]" />
  );
}

export function FilterBar({ children }) {
  return <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 no-print">{children}</div>;
}

/** Facility picker populated from the API; hidden for facility-bound users who only have one. */
export function useFacilities() {
  const [list, setList] = useState([]);
  useEffect(() => {
    let alive = true;
    get('/facilities', { limit: 100 }).then((r) => alive && setList(r.data)).catch(() => {});
    return () => { alive = false; };
  }, []);
  return list;
}

export function FacilityFilter({ value, onChange }) {
  const facilities = useFacilities();
  if (facilities.length <= 1) return null;
  return <FilterSelect label="Facility" value={value} onChange={onChange} placeholder="All facilities" options={facilities.map((f) => ({ value: f.id, label: f.name }))} />;
}
