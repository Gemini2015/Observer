import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import Issues from './pages/Issues';
import Jobs from './pages/Jobs';
import Login from './pages/Login';
import Machines from './pages/Machines';
import MountDetail from './pages/MountDetail';
import Overview from './pages/Overview';

const links = [
  { to: '/', label: '总览' },
  { to: '/machines', label: '机器与挂载点' },
  { to: '/jobs', label: '任务' },
  { to: '/issues', label: '异常' },
];

function Shell({ onLogout }: { onLogout: () => void }) {
  const location = useLocation();
  return (
    <div className="app">
      <aside className="nav">
        <div className="brand">Observer</div>
        <nav>
          {links.map((link) => {
            const active =
              link.to === '/' ? location.pathname === '/' : location.pathname.startsWith(link.to);
            return (
              <Link key={link.to} to={link.to} className={active ? 'active' : undefined}>
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="spacer" />
        <button type="button" onClick={onLogout}>
          退出登录
        </button>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/machines" element={<Machines />} />
          <Route path="/mounts/:id" element={<MountDetail />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/issues" element={<Issues />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<'checking' | 'in' | 'out'>('checking');

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
    } finally {
      setStatus('out');
    }
  };

  if (status === 'checking') {
    return <div className="boot">加载中…</div>;
  }
  if (status === 'out') {
    return <Login onSuccess={() => setStatus('in')} />;
  }
  return (
    <BrowserRouter>
      <Shell onLogout={logout} />
    </BrowserRouter>
  );
}
