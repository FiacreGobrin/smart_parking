import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { http, post, refreshSession, setAccessToken, setAuthLostHandler } from '../services/api.js';
import { connectSocket, disconnectSocket } from '../services/socket.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);

  const clear = useCallback(() => {
    try { localStorage.removeItem('sp_hint'); } catch { /* ignore */ }
    setAccessToken(null);
    setUser(null);
    disconnectSocket();
  }, []);

  useEffect(() => {
    setAuthLostHandler(clear);
    // Restore the session from the refresh cookie on page load. The hint only avoids a pointless
    // (and noisy) request for visitors who never signed in; it holds no credentials.
    let hint = false;
    try { hint = localStorage.getItem('sp_hint') === '1'; } catch { /* ignore */ }
    if (!hint) { setBooting(false); return; }
    refreshSession()
      .then((data) => { setUser(data.user); connectSocket(); })
      .catch((err) => {
        // Only an explicit 401 means the session is gone; a 429 or network error should not forget it.
        if (err?.response?.status === 401) { try { localStorage.removeItem('sp_hint'); } catch { /* ignore */ } }
      })
      .finally(() => setBooting(false));
  }, [clear]);

  const login = useCallback(async (username, password, code) => {
    const { data } = await post('/auth/login', { username, password, ...(code ? { code } : {}) });
    setAccessToken(data.accessToken);
    try { localStorage.setItem('sp_hint', '1'); } catch { /* ignore */ }
    setUser(data.user);
    connectSocket();
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try { await http.post('/auth/logout'); } catch { /* the local session is cleared regardless */ }
    clear();
  }, [clear]);

  const refreshUser = useCallback(async () => {
    const res = await http.get('/auth/me');
    setUser(res.data.data);
  }, []);

  const can = useCallback((perm) => {
    if (!user) return false;
    if (!perm) return true;
    const list = Array.isArray(perm) ? perm : [perm];
    return user.permissions.includes('*') || list.some((p) => user.permissions.includes(p));
  }, [user]);

  const value = useMemo(() => ({ user, booting, login, logout, refreshUser, can }), [user, booting, login, logout, refreshUser, can]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
