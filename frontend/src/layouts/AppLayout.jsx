import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { LogOut, Menu, Moon, Sun, User, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useUi } from '../context/UiContext.jsx';
import { NAV_ITEMS, titleFor } from '../routes/navigation.js';
import { titleCase } from '../utils/format.js';

const roleLabel = (r) => (r === 'SUPER_ADMIN' ? 'Admin' : r === 'PARKING_ADMIN' ? 'Parking admin' : titleCase(r));

function Sidebar({ onNavigate }) {
  const { user, can, logout } = useAuth();
  const { theme, setTheme } = useUi();
  const navigate = useNavigate();
  return (
    <aside className="flex h-full flex-col bg-sidebar text-sidebar-ink" aria-label="Main navigation">
      <div className="px-8 pb-6 pt-9">
        <p className="text-[22px] font-bold leading-tight text-white">Smart Parking</p>
        <p className="mt-1 text-[13px] text-sidebar-ink/70">{roleLabel(user.role)}</p>
      </div>
      <nav className="flex-1 overflow-y-auto px-4 py-2">
        <ul className="space-y-2">
          {NAV_ITEMS.filter((i) => can(i.perm)).map((i) => (
            <li key={i.to}>
              <NavLink to={i.to} end={i.end} onClick={onNavigate}
                className={({ isActive }) => clsx(
                  'block rounded-xl px-5 py-3 text-[15px] font-medium transition-colors',
                  isActive ? 'bg-primary text-white' : 'hover:bg-sidebar-2 hover:text-white',
                )}>
                {i.title}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-white/10 px-4 py-4">
        <button onClick={() => { navigate('/profile'); onNavigate?.(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-sidebar-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">{user.name.slice(0, 1).toUpperCase()}</span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-medium text-white">{user.name}</span>
            <span className="block truncate text-xs text-sidebar-ink/70">{user.username}</span>
          </span>
          <User className="ml-auto h-4 w-4 shrink-0 text-sidebar-ink/60" aria-hidden />
        </button>
        <div className="mt-2 flex gap-2">
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs hover:bg-sidebar-2 hover:text-white"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <button onClick={async () => { await logout(); navigate('/login'); }} className="flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs hover:bg-sidebar-2 hover:text-white">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}

export default function AppLayout() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => { document.title = `${titleFor(pathname)} - Smart Parking`; }, [pathname]);

  return (
    <div className="min-h-screen bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[100] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>

      <div className="fixed inset-y-0 left-0 z-30 hidden w-[260px] lg:block no-print"><Sidebar /></div>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden no-print">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw]">
            <Sidebar onNavigate={() => setOpen(false)} />
            <button onClick={() => setOpen(false)} aria-label="Close menu" className="absolute right-3 top-4 rounded-md p-1 text-white/70 hover:text-white"><X className="h-5 w-5" /></button>
          </div>
        </div>
      )}

      <div className="lg:pl-[260px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur lg:hidden no-print">
          <button onClick={() => setOpen(true)} className="rounded-lg p-2 text-muted hover:bg-surface-2" aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <p className="font-semibold text-ink">{titleFor(pathname)}</p>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-8 lg:px-10 lg:py-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
