import { useCallback, useEffect, useRef, useState } from 'react';
import { parseError } from '../services/api.js';

/**
 * Runs an async loader whenever `deps` change.
 * Returns { data, meta, loading, error, reload }. Stale responses are ignored.
 */
export function useFetch(loader, deps = [], { pollMs } = {}) {
  const [state, setState] = useState({ data: null, meta: null, loading: true, error: null });
  const seq = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback(async (silent = false) => {
    const id = ++seq.current;
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await loaderRef.current();
      if (id === seq.current) setState({ data: res.data, meta: res.meta ?? null, loading: false, error: null });
    } catch (err) {
      if (id === seq.current) setState((s) => ({ ...s, loading: false, error: parseError(err) }));
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, deps);

  // Fallback refresh when real-time updates are unavailable.
  useEffect(() => {
    if (!pollMs) return undefined;
    const t = setInterval(() => { if (!document.hidden) run(true); }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, run]);

  return { ...state, reload: run };
}
