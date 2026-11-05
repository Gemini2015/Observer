import { Suspense, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, type IssueSummary, type SystemInfo } from '../api';
import { usePolling } from '../lib/hooks';
import { PageLoading } from '../components/PageLoading';
import { NavIcon, type NavIconName } from './navIcons';
import { AppRoutes } from './routes';

interface NavItem {
  to: string;
  label: string;
  icon: NavIconName;
  matches: (pathname: string) => boolean;
  badge?: number;
}

export function AppShell({ onLogout }: { onLogout: () => void }) {
  const location = useLocation();

  const health = usePolling(async () => api<{ status: string }>('/healthz'), {
    intervalMs: 30_000,
  });
  const system = usePolling(async () => api<SystemInfo>('/api/v1/system'), {
    intervalMs: 300_000,
  });
  const summary = usePolling(
    async (signal) => api<IssueSummary>('/api/v1/issues/summary', { signal }),
    { intervalMs: 30_000 },
  );

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  const openIssues = summary.data?.status.open;
  const healthyLabel = health.data ? '中心服正常' : health.error ? '中心服不可达' : '连接中';
  const healthClass = health.data ? 'ok' : health.error ? 'bad' : '';

  const groups: Array<{ title: string; items: NavItem[] }> = [
    {
      title: '巡检',
      items: [
        { to: '/', label: '总览', icon: 'overview', matches: (path) => path === '/' },
        {
          to: '/machines',
          label: '机器',
          icon: 'machines',
          matches: (path) => path.startsWith('/machines') || path.startsWith('/mounts'),
        },
        { to: '/jobs', label: '任务', icon: 'jobs', matches: (path) => path.startsWith('/jobs') },
      ],
    },
    {
      title: '数据',
      items: [
        { to: '/files', label: '文件', icon: 'files', matches: (path) => path.startsWith('/files') },
        {
          to: '/issues',
          label: '异常',
          icon: 'issues',
          matches: (path) => path.startsWith('/issues'),
          badge: openIssues,
        },
        {
          to: '/repairs',
          label: '修复',
          icon: 'repairs',
          matches: (path) => path.startsWith('/repairs'),
        },
      ],
    },
    {
      title: '系统',
      items: [
        { to: '/audit', label: '审计', icon: 'audit', matches: (path) => path.startsWith('/audit') },
        {
          to: '/system',
          label: '系统',
          icon: 'system',
          matches: (path) => path.startsWith('/system'),
        },
      ],
    },
  ];

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/logo.svg" alt="" />
          <span>Observer</span>
        </div>
        <nav className="sidebar-nav" aria-label="主导航">
          {groups.map((group) => (
            <div className="nav-group" key={group.title}>
              <div className="nav-group-title">{group.title}</div>
              {group.items.map((item) => {
                const active = item.matches(location.pathname);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className="nav-link"
                    aria-current={active ? 'page' : undefined}
                  >
                    <NavIcon name={item.icon} />
                    <span>{item.label}</span>
                    {item.badge && item.badge > 0 ? (
                      <span className="nav-badge">{item.badge > 99 ? '99+' : item.badge}</span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-health">
            <span className={`health-dot ${healthClass}`} aria-hidden="true" />
            <span>{healthyLabel}</span>
          </div>
          <span>版本 {system.data?.version ?? '—'}</span>
          <button className="btn btn-sm" type="button" onClick={onLogout}>
            退出登录
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="content" id="main-content">
          <Suspense fallback={<PageLoading />}>
            <AppRoutes />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
