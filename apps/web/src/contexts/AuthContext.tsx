'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { request, type User } from '@/lib/api';

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  updateName: (name: string) => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    for (const key of [
      'uwifin_token',
      'uwifin_user',
      'uwifin-demo-profile',
      'uwifin-demo-finances-v1',
    ])
      localStorage.removeItem(key);
    const controller = new AbortController();
    request<User>('/auth/me', { signal: controller.signal })
      .then(setUser)
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  const login = async (email: string, password: string) => {
    const result = await request<{ user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setUser(result.user);
  };
  const register = async (email: string, password: string, name: string) => {
    const result = await request<{ user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
    setUser(result.user);
  };
  const logout = async () => {
    await request('/auth/logout', { method: 'POST' });
    setUser(null);
  };
  const updateName = async (name: string) => {
    await request('/users/me', { method: 'PATCH', body: JSON.stringify({ name }) });
    setUser((current) => (current ? { ...current, name } : null));
  };
  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateName }}>
      {children}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is required.');
  return context;
}
