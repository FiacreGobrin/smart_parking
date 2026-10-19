import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Spinner } from '../components/ui/States.jsx';

// Route guards improve the experience only; every API call is authorized again on the server.
export function RequireAuth() {
  const { user, booting } = useAuth();
  const location = useLocation();
  if (booting) return <div className="flex min-h-screen items-center justify-center bg-bg"><Spinner label="Restoring session" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

export function RequirePermission({ perm, children }) {
  const { can } = useAuth();
  if (!can(perm)) return <Navigate to="/forbidden" replace />;
  return children;
}
