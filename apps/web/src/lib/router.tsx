import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

interface RouterState {
  path: string;
  search: URLSearchParams;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterState | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, search: window.location.search }));
  useEffect(() => {
    const onPop = () => setLoc({ path: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string, opts: { replace?: boolean } = {}) => {
    if (opts.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    const u = new URL(to, window.location.origin);
    setLoc({ path: u.pathname, search: u.search });
    if (!opts.replace) window.scrollTo(0, 0);
  }, []);
  const value = useMemo(() => ({ path: loc.path, search: new URLSearchParams(loc.search), navigate }), [loc, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterState {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter outside RouterProvider');
  return ctx;
}

/** Matches `/repositories/:id` style patterns. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

/** Updates query parameters in place (filters), keeping history clean. */
export function useQueryState(): [URLSearchParams, (patch: Record<string, string | null | undefined>) => void] {
  const { path, search, navigate } = useRouter();
  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, v);
      }
      const q = next.toString();
      navigate(`${path}${q ? `?${q}` : ''}`, { replace: true });
    },
    [path, search, navigate],
  );
  return [search, set];
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate, path } = useRouter();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  const current = to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`);
  return (
    <a href={to} {...rest} onClick={onClick} aria-current={rest['aria-current'] ?? (current && rest.className?.includes('nav-link') ? 'page' : undefined)}>
      {children}
    </a>
  );
}
