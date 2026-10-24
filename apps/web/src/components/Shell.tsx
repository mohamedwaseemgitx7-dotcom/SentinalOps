import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useLive, useResource, type ActivityEvent } from '../lib/live';
import { Link, useRouter } from '../lib/router';
import { Icon, Logo, type IconName } from './icons';

export interface SessionUser {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
}

const NAV: { section?: string; items: { to: string; label: string; icon: IconName }[] }[] = [
  { items: [{ to: '/', label: 'Overview', icon: 'overview' }] },
  {
    section: 'Engineering',
    items: [
      { to: '/repositories', label: 'Repositories', icon: 'repo' },
      { to: '/pipelines', label: 'Pipelines', icon: 'pipeline' },
      { to: '/security', label: 'Security', icon: 'shield' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/monitoring', label: 'Monitoring', icon: 'pulse' },
      { to: '/incidents', label: 'Incidents', icon: 'alert' },
      { to: '/load-tests', label: 'Load tests', icon: 'gauge' },
      { to: '/analytics', label: 'Analytics', icon: 'chart' },
    ],
  },
  { section: 'Account', items: [{ to: '/settings', label: 'Settings', icon: 'settings' }] },
];

export function levelIcon(level: ActivityEvent['level']): { name: IconName; color: string } {
  return level === 'critical' ? { name: 'critical', color: 'var(--critical-text)' }
    : level === 'warning' ? { name: 'warn', color: 'var(--warning)' }
    : level === 'success' ? { name: 'ok', color: 'var(--good-text)' }
    : { name: 'info', color: 'var(--accent)' };
}

export function EventFeed({ events, limit = 12 }: { events: ActivityEvent[]; limit?: number }) {
  const { navigate } = useRouter();
  if (!events.length) return <p className="muted" style={{ padding: '12px 0' }}>No activity yet. Connect a repository or add a monitor to see live events here.</p>;
  return (
    <ul className="feed" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-live="polite">
      {events.slice(0, limit).map((e) => {
        const ic = levelIcon(e.level);
        return (
          <li className="feed-item" key={e.id}>
            <span style={{ color: ic.color, paddingTop: 1 }}><Icon name={ic.name} size={16} /><span className="sr-only">{e.level}</span></span>
            <div>
              {e.link ? (
                <a href={e.link} className="msg" onClick={(ev) => (ev.preventDefault(), navigate(e.link!))}>{e.message}</a>
              ) : (
                <div className="msg">{e.message}</div>
              )}
              <div className="time"><time dateTime={e.ts} title={new Date(e.ts).toLocaleString()}>{timeAgo(e.ts)}</time></div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

interface SearchResults {
  repositories: { id: number; title: string }[];
  incidents: { id: number; title: string; status: string }[];
  findings: { id: number; title: string; severity: string; repo_id: number }[];
  runs: { id: number; title: string; conclusion: string | null; branch: string }[];
  monitors: { id: number; title: string; url: string }[];
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const { navigate } = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (q.trim().length < 2) return setResults(null);
    const t = setTimeout(() => api.get<SearchResults>(`/api/search?q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => setResults(null)), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.querySelector('input')?.focus();
      }
    };
    const onClick = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => (document.removeEventListener('keydown', onKey), document.removeEventListener('mousedown', onClick));
  }, []);
  const go = (to: string) => (setOpen(false), setQ(''), navigate(to));
  const groups: [string, { key: string; label: string; to: string; meta?: string }[]][] = results
    ? [
        ['Repositories', results.repositories.map((r) => ({ key: `r${r.id}`, label: r.title, to: `/repositories/${r.id}` }))],
        ['Incidents', results.incidents.map((r) => ({ key: `i${r.id}`, label: r.title, to: `/incidents/${r.id}`, meta: r.status }))],
        ['Findings', results.findings.map((r) => ({ key: `f${r.id}`, label: r.title, to: `/security?finding=${r.id}`, meta: r.severity }))],
        ['Pipeline runs', results.runs.map((r) => ({ key: `p${r.id}`, label: `${r.title} · ${r.branch}`, to: `/pipelines/${r.id}`, meta: r.conclusion ?? '' }))],
        ['Monitors', results.monitors.map((r) => ({ key: `m${r.id}`, label: r.title, to: `/monitoring/${r.id}` }))],
      ]
    : [];
  const total = groups.reduce((a, [, items]) => a + items.length, 0);
  return (
    <div className="search" ref={ref} role="search">
      <span className="icon"><Icon name="search" size={16} /></span>
      <label htmlFor="global-search" className="sr-only">Search incidents, repositories, runs and findings</label>
      <input id="global-search" value={q} onChange={(e) => (setQ(e.target.value), setOpen(true))} onFocus={() => setOpen(true)} placeholder="Search incidents, repositories, runs…  (Ctrl+K)" autoComplete="off" />
      {open && results && (
        <div className="search-results">
          {total === 0 && <div className="muted" style={{ padding: 10 }}>No matches for “{q}”.</div>}
          {groups.filter(([, items]) => items.length).map(([name, items]) => (
            <div key={name}>
              <div className="group">{name}</div>
              {items.map((it) => (
                <a key={it.key} href={it.to} onClick={(e) => (e.preventDefault(), go(it.to))}>
                  <span className="truncate" style={{ flex: 1 }}>{it.label}</span>
                  {it.meta && <span className="muted" style={{ fontSize: 12 }}>{it.meta}</span>}
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const { events, unread, markRead } = useLive();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);
  const important = events.filter((e) => e.level === 'warning' || e.level === 'critical');
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => (setOpen((o) => !o), markRead())}>
        <Icon name="bell" />
        {unread > 0 && <span className="dot" />}
      </button>
      {open && (
        <div className="popover">
          <div className="spread" style={{ padding: '6px 8px' }}>
            <strong>Alerts</strong>
            <span className="muted" style={{ fontSize: 12 }}>warnings & critical events</span>
          </div>
          <div style={{ maxHeight: 360, overflow: 'auto', padding: '0 8px' }}>
            <EventFeed events={important} limit={15} />
          </div>
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('so-theme') ?? 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('so-theme', theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  return (
    <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}

export function Shell({ user, onLogout, children }: { user: SessionUser; onLogout: () => void; children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const { path } = useRouter();
  const { connected } = useLive();
  const counts = useResource<{ incidents: unknown[]; total: number }>('/api/incidents?status=active&limit=1', ['incidents']);
  useEffect(() => setNavOpen(false), [path]);
  const isCurrent = (to: string) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));
  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <a href="#main" className="skip-link">Skip to content</a>
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <div className="brand-mark"><Logo size={19} /></div>
          <div>
            <div className="brand-name">SentinelOps</div>
            <div className="brand-sub">DevOps intelligence</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((group, gi) => (
            <div key={gi} style={{ display: 'contents' }}>
              {group.section && <div className="nav-section">{group.section}</div>}
              {group.items.map((item) => (
                <Link key={item.to} to={item.to} aria-current={isCurrent(item.to) ? 'page' : undefined}>
                  <Icon name={item.icon} />
                  {item.label}
                  {item.to === '/incidents' && (counts.data?.total ?? 0) > 0 && <span className="count" aria-label={`${counts.data!.total} active`}>{counts.data!.total}</span>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="row" style={{ gap: 6 }}>
            <span className={`live ${connected ? '' : 'off'}`}><span className="pulse" />{connected ? 'Live' : 'Reconnecting'}</span>
          </div>
          <div style={{ marginTop: 8 }}>v0.1.0 · local-first</div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setNavOpen(true)} aria-label="Open navigation"><Icon name="menu" /></button>
          <GlobalSearch />
          <div className="topbar-actions">
            <Notifications />
            <ThemeToggle />
            <Link to="/settings" className="icon-btn hide-sm" aria-label="Settings"><Icon name="settings" /></Link>
            <div style={{ position: 'relative' }}>
              <button className="user-chip" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-haspopup="menu" aria-label={`Account menu for ${user.username}`}>
                <span className="avatar" aria-hidden="true">{user.username.slice(0, 2).toUpperCase()}</span>
                <span className="name" style={{ fontSize: 13 }}>{user.username}</span>
              </button>
              {menu && (
                <div className="popover" role="menu" style={{ width: 220 }}>
                  <div style={{ padding: '6px 8px 10px' }}>
                    <div style={{ fontWeight: 600 }}>{user.username}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{user.role === 'admin' ? 'Administrator' : 'Viewer (read-only)'}</div>
                  </div>
                  <button className="btn btn-ghost" role="menuitem" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={onLogout}>
                    <Icon name="logout" size={16} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
