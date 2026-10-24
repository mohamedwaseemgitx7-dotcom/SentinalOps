import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

export interface ActivityEvent {
  id: number;
  ts: string;
  type: string;
  level: 'info' | 'success' | 'warning' | 'critical';
  message: string;
  link: string | null;
}

interface LiveState {
  connected: boolean;
  events: ActivityEvent[];
  /** Increments per topic whenever the server says cached data changed. */
  versions: Record<string, number>;
  unread: number;
  markRead: () => void;
}

const LiveContext = createContext<LiveState>({ connected: false, events: [], versions: {}, unread: 0, markRead: () => {} });

/** One EventSource per tab; pages re-fetch when their topic is invalidated (no polling). */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.get<{ events: ActivityEvent[] }>('/api/events?limit=30').then((r) => !cancelled && setEvents(r.events)).catch(() => {});
    const es = new EventSource('/api/events/stream', { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('activity', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as ActivityEvent;
      setEvents((prev) => [ev, ...prev.filter((p) => p.id !== ev.id)].slice(0, 60));
      if (ev.level === 'warning' || ev.level === 'critical') setUnread((n) => n + 1);
      // Activity usually means overview numbers moved.
      setVersions((v) => ({ ...v, overview: (v.overview ?? 0) + 1 }));
    });
    es.addEventListener('invalidate', (e) => {
      const { topic } = JSON.parse((e as MessageEvent<string>).data) as { topic: string };
      setVersions((v) => ({ ...v, [topic]: (v[topic] ?? 0) + 1, overview: (v.overview ?? 0) + 1 }));
    });
    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  const markRead = useCallback(() => setUnread(0), []);
  return <LiveContext.Provider value={{ connected, events, versions, unread, markRead }}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  return useContext(LiveContext);
}

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetches `url` and re-fetches when any of `topics` is invalidated by the live stream.
 * Debounced so a burst of server events triggers one request.
 */
export function useResource<T>(url: string | null, topics: string[] = []): Resource<T> {
  const { versions } = useLive();
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: !!url });
  const [nonce, setNonce] = useState(0);
  const versionKey = topics.map((t) => versions[t] ?? 0).join(',');
  const seq = useRef(0);
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!url) return;
    const mySeq = ++seq.current;
    const urlChanged = lastUrl.current !== url;
    lastUrl.current = url;
    if (urlChanged) setState((s) => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(
      () => {
        api
          .get<T>(url)
          .then((data) => mySeq === seq.current && setState({ data, error: null, loading: false }))
          .catch((error: ApiError) => mySeq === seq.current && setState((s) => ({ data: s.data, error, loading: false })));
      },
      urlChanged ? 0 : 400,
    );
    return () => clearTimeout(timer);
  }, [url, versionKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
