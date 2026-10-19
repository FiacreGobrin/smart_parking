import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './layouts/AppLayout.jsx';
import { RequireAuth, RequirePermission } from './routes/ProtectedRoute.jsx';
import { Spinner } from './components/ui/States.jsx';
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SignUpPage } from './pages/AuthPages.jsx';
import { useAuth } from './context/AuthContext.jsx';
import { NAV_ITEMS } from './routes/navigation.js';

// Pages are split out so the first load stays small.
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const UsersPage = lazy(() => import('./pages/UsersPage.jsx'));
const PricesPage = lazy(() => import('./pages/PricesPage.jsx'));
const OperationsPage = lazy(() => import('./pages/OperationsPage.jsx'));
const ReportsPage = lazy(() => import('./pages/ReportsPage.jsx'));
const PaymentsPage = lazy(() => import('./pages/PaymentsPage.jsx'));
const SettingsHub = lazy(() => import('./pages/SettingsHub.jsx'));
const Process = lazy(() => import('./pages/ProcessAndTelephone.jsx').then((m) => ({ default: m.BusinessProcessPage })));
const Telephone = lazy(() => import('./pages/ProcessAndTelephone.jsx').then((m) => ({ default: m.TelephonePage })));
const System = (name) => lazy(() => import('./pages/SystemPages.jsx').then((m) => ({ default: m[name] })));
const ProfilePage = System('ProfilePage');
const ForbiddenPage = System('ForbiddenPage');
const NotFoundPage = System('NotFoundPage');

const guard = (perm, el) => <RequirePermission perm={perm}>{el}</RequirePermission>;
const perm = (to) => NAV_ITEMS.find((i) => i.to === to).perm;

// Lands each role on the first screen it may use (a user without dashboard access starts at Operations).
function Home() {
  const { can } = useAuth();
  const first = NAV_ITEMS.find((i) => can(i.perm));
  if (first && first.to !== '/') return <Navigate to={first.to} replace />;
  return can('dashboard.read') ? <Dashboard /> : <Navigate to="/profile" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignUpPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppLayout />}>
              <Route index element={<Home />} />
              <Route path="users" element={guard(perm('/users'), <UsersPage />)} />
              <Route path="prices" element={guard(perm('/prices'), <PricesPage />)} />
              <Route path="operations" element={guard(perm('/operations'), <OperationsPage />)} />
              <Route path="process" element={guard(perm('/process'), <Process />)} />
              <Route path="statistics" element={guard(perm('/statistics'), <ReportsPage />)} />
              <Route path="finance" element={guard(perm('/finance'), <PaymentsPage />)} />
              <Route path="telephone" element={guard(perm('/telephone'), <Telephone />)} />
              <Route path="settings" element={guard(perm('/settings'), <SettingsHub />)} />
              <Route path="profile" element={<ProfilePage />} />
              <Route path="forbidden" element={<ForbiddenPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
