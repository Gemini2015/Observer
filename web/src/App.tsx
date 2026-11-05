import { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { api } from './api';
import { AppShell } from './app/AppShell';
import { ConfirmProvider } from './components/ConfirmDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import Login from './pages/Login';

type Status = 'checking' | 'in' | 'out';

export default function App() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    let cancelled = false;
    api('/api/v1/me')
      .then(() => {
        if (!cancelled) setStatus('in');
      })
      .catch(() => {
        if (!cancelled) setStatus('out');
      });

    const onUnauthorized = () => setStatus('out');
    window.addEventListener('observer:unauthorized', onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener('observer:unauthorized', onUnauthorized);
    };
  }, []);

  const logout = async () => {
    try {
      await api('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // 会话可能已经失效；无论结果如何都回到登录页
    } finally {
      setStatus('out');
    }
  };

  if (status === 'checking') {
    return (
      <div className="boot">
        <img src="/logo.svg" alt="" />
        <span>正在连接中心服…</span>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
        <ConfirmProvider>
          {status === 'out' ? (
            <Login onSuccess={() => setStatus('in')} />
          ) : (
            <BrowserRouter>
              <AppShell onLogout={() => void logout()} />
            </BrowserRouter>
          )}
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
