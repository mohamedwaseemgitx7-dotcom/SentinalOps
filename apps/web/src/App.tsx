import { useCallback, useEffect, useState } from 'react';
import { Shell, type SessionUser } from './components/Shell';
import { EmptyState, ErrorState, Skeleton } from './components/ui';
import { api, ApiError, onUnauthorized, setCsrfToken } from './lib/api';
import { LiveProvider } from './lib/live';
import { Link, matchPath, RouterProvider, useRouter } from './lib/router';
import { AnalyticsPage } from './pages/Analytics';
import { AuthPage } from './pages/Auth';
import { IncidentDetailPage, IncidentsPage } from './pages/Incidents';
import { LoadTestDetailPage, LoadTestsPage } from './pages/LoadTests';
import { MonitorDetailPage, MonitoringPage, SiteScanPage } from './pages/Monitoring';
import { OverviewPage } from './pages/Overview';
import { PipelinesPage, RunDetailPage } from './pages/Pipelines';
import { RepositoriesPage } from './pages/Repositories';
import { RepositoryDetailPage } from './pages/RepositoryDetail';
import { SecurityPage } from './pages/Security';
import { SettingsPage } from './pages/Settings';

interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  user: SessionUser | null;
  csrfToken: string | null;
}

const TITLES: [string, string][] = [
  ['/repositories', 'Repositories'], ['/pipelines', 'Pipelines'], ['/security', 'Security'], ['/monitoring', 'Monitoring'],
  ['/incidents', 'Incidents'], ['/load-tests', 'Load tests'], ['/analytics', 'Analytics'], ['/settings', 'Settings'],
];

function Routes({ user }: { user: SessionUser }) {
  const { path } = useRouter();
  const isAdmin = user.role === 'admin';
  useEffect(() => {
    const t = TITLES.find(([p]) => path.startsWith(p))?.[1] ?? 'Overview';
    document.title = `${t} · SentinelOps`;
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [path]);
  let m: Record<string, string> | null;
  if (path === '/') return <OverviewPage isAdmin={isAdmin} />;
  if (path === '/repositories') return <RepositoriesPage isAdmin={isAdmin} />;
  if ((m = matchPath('/repositories/:id', path))) return <RepositoryDetailPage key={m.id} id={Number(m.id)} isAdmin={isAdmin} />;
  if (path === '/pipelines') return <PipelinesPage />;
  if ((m = matchPath('/pipelines/:id', path))) return <RunDetailPage key={m.id} id={Number(m.id)} isAdmin={isAdmin} />;
  if (path === '/security') return <SecurityPage isAdmin={isAdmin} />;
  if (path === '/monitoring') return <MonitoringPage isAdmin={isAdmin} />;
  if ((m = matchPath('/monitoring/scan/:id', path))) return <SiteScanPage key={m.id} id={Number(m.id)} />;
  if ((m = matchPath('/monitoring/:id', path))) return <MonitorDetailPage key={m.id} id={Number(m.id)} isAdmin={isAdmin} />;
  if (path === '/incidents') return <IncidentsPage isAdmin={isAdmin} />;
  if ((m = matchPath('/incidents/:id', path))) return <IncidentDetailPage key={m.id} id={Number(m.id)} isAdmin={isAdmin} />;
  if (path === '/load-tests') return <LoadTestsPage isAdmin={isAdmin} />;
  if ((m = matchPath('/load-tests/:id', path))) return <LoadTestDetailPage key={m.id} id={Number(m.id)} />;
  if (path === '/analytics') return <AnalyticsPage />;
  if (path === '/settings') return <SettingsPage user={user} />;
  return <EmptyState icon="unknown" title="Page not found" action={<Link to="/" className="btn">Go to overview</Link>}>The address {path} does not exist.</EmptyState>;
}

function Root() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const { path, navigate } = useRouter();

  const load = useCallback(() => {
    api
      .get<AuthStatus>('/api/auth/status')
      .then((s) => {
        setCsrfToken(s.csrfToken);
        setStatus(s);
        setError(null);
      })
      .catch(setError);
  }, []);
  useEffect(load, [load]);
  useEffect(() => onUnauthorized(() => setStatus((s) => (s ? { ...s, authenticated: false, user: null } : s))), []);

  if (error && !status) return <div className="auth-page"><div className="auth-card"><ErrorState error={error} onRetry={load} /></div></div>;
  if (!status) return <div className="auth-page"><Skeleton height={320} width={420} /></div>;

  const onAuthenticated = (user: SessionUser, csrf: string) => {
    setCsrfToken(csrf);
    setStatus({ setupRequired: false, authenticated: true, user, csrfToken: csrf });
    navigate('/', { replace: true });
  };
  if (status.setupRequired) return <AuthPage mode="setup" onAuthenticated={onAuthenticated} />;
  if (!status.authenticated || !status.user) return <AuthPage mode={path === '/invite' ? 'invite' : 'login'} onAuthenticated={onAuthenticated} />;

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setCsrfToken(null);
    setStatus({ ...status, authenticated: false, user: null, csrfToken: null });
    navigate('/', { replace: true });
  };
  return (
    <LiveProvider>
      <Shell user={status.user} onLogout={logout}>
        <Routes user={status.user} />
      </Shell>
    </LiveProvider>
  );
}

export function App() {
  return (
    <RouterProvider>
      <Root />
    </RouterProvider>
  );
}
