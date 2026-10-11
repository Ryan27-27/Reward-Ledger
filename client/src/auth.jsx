import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, post, refreshSession, setToken, onSessionExpired } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const qc = useQueryClient();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    refreshSession().then((s) => { if (s) setUser(s.user); }).finally(() => setLoading(false));
    return onSessionExpired(() => { setUser(null); qc.clear(); });
  }, [qc]);

  const accept = useCallback((data) => { setToken(data.accessToken); setUser(data.user); return data.user; }, []);
  const value = {
    user, loading,
    login: async (email, password) => accept(await post('/auth/login', { email, password })),
    verifyEmail: async (email, code) => accept(await post('/auth/verify-email', { email, code })),
    logout: async () => { await post('/auth/logout').catch(() => {}); setToken(null); setUser(null); qc.clear(); },
    refreshUser: async () => setUser((await api('/auth/me')).user),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
