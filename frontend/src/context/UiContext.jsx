import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import { Modal } from '../components/ui/Modal.jsx';
import { Button } from '../components/ui/Button.jsx';

const UiContext = createContext(null);

const TOAST_STYLE = {
  success: { icon: CheckCircle2, cls: 'text-success' },
  error: { icon: XCircle, cls: 'text-danger' },
  warning: { icon: TriangleAlert, cls: 'text-warning' },
  info: { icon: Info, cls: 'text-accent' },
};

export function UiProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const [theme, setThemeState] = useState(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  const idRef = useRef(0);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((message, type = 'success') => {
    const id = ++idRef.current;
    setToasts((t) => [...t.slice(-3), { id, message, type }]);
    setTimeout(() => dismiss(id), type === 'error' ? 7000 : 4000);
  }, [dismiss]);

  const confirm = useCallback((opts) => new Promise((resolve) => setConfirmState({ ...opts, resolve })), []);
  const closeConfirm = (result) => { confirmState?.resolve(result); setConfirmState(null); };

  const setTheme = useCallback((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    try { localStorage.setItem('sp_theme', t); } catch { /* storage may be unavailable */ }
    setThemeState(t);
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && confirmState && closeConfirm(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const value = useMemo(() => ({ toast, confirm, theme, setTheme }), [toast, confirm, theme, setTheme]);

  return (
    <UiContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[70] flex w-[min(92vw,380px)] flex-col gap-2 no-print" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => {
          const { icon: Icon, cls } = TOAST_STYLE[t.type] || TOAST_STYLE.info;
          return (
            <div key={t.id} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 shadow-card">
              <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${cls}`} aria-hidden />
              <p className="flex-1 text-sm text-ink">{t.message}</p>
              <button onClick={() => dismiss(t.id)} className="text-muted hover:text-ink" aria-label="Dismiss"><X className="h-4 w-4" /></button>
            </div>
          );
        })}
      </div>
      <Modal open={!!confirmState} onClose={() => closeConfirm(false)} title={confirmState?.title || 'Are you sure?'} size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => closeConfirm(false)}>Cancel</Button>
            <Button variant={confirmState?.danger ? 'danger' : 'primary'} onClick={() => closeConfirm(true)}>{confirmState?.confirmLabel || 'Confirm'}</Button>
          </>
        )}>
        <p className="text-sm text-muted">{confirmState?.message}</p>
      </Modal>
    </UiContext.Provider>
  );
}

export const useUi = () => useContext(UiContext);
