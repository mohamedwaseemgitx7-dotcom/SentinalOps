import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { ApiError } from '../lib/api';
import { Icon, type IconName } from './icons';

export type Tone = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'good' | 'warning' | 'unknown' | 'accent';

const TONE_ICON: Partial<Record<Tone, IconName>> = {
  critical: 'critical', high: 'warn', medium: 'warn', warning: 'warn', low: 'info', info: 'info', good: 'ok', unknown: 'unknown',
};

/** Status is never conveyed by color alone: every badge carries an icon and a text label. */
export function Badge({ tone, children, icon = true }: { tone: Tone; children: ReactNode; icon?: boolean }) {
  const name = TONE_ICON[tone];
  return (
    <span className={`badge b-${tone}`}>
      {icon && name && <Icon name={name} size={12} />}
      {children}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const tone = (['critical', 'high', 'medium', 'low', 'info'].includes(severity) ? severity : 'unknown') as Tone;
  return <Badge tone={tone}>{severity}</Badge>;
}

export function conclusionTone(c: string | null | undefined, status?: string | null): Tone {
  if (status && status !== 'completed') return 'accent';
  if (c === 'success') return 'good';
  if (c === 'failure' || c === 'timed_out' || c === 'startup_failure') return 'critical';
  if (c === 'cancelled' || c === 'skipped' || c === 'neutral') return 'unknown';
  return 'unknown';
}

export function RunBadge({ conclusion, status }: { conclusion: string | null; status?: string | null }) {
  const label = status && status !== 'completed' ? status.replace('_', ' ') : conclusion?.replace('_', ' ') ?? 'unknown';
  return <Badge tone={conclusionTone(conclusion, status)}>{label}</Badge>;
}

export function Card({ title, hint, actions, children, className = '', id }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`card ${className}`} id={id} aria-labelledby={title && id ? `${id}-title` : undefined}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2 id={id ? `${id}-title` : undefined}>{title}</h2>}
            {hint && <div className="hint">{hint}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Skeleton({ height = 16, width = '100%', style }: { height?: number; width?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height, width, ...style }} aria-hidden="true" />;
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={i === 0 ? 22 : 14} width={i === 0 ? '40%' : `${90 - i * 9}%`} />
      ))}
    </div>
  );
}

export function EmptyState({ icon = 'info', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon-wrap">
        <Icon name={icon} size={22} />
      </div>
      <h3>{title}</h3>
      {children && <p style={{ maxWidth: 460 }}>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  const status = (error as ApiError).status;
  const hint =
    status === 0 ? 'The SentinelOps server is not reachable. If you use the desktop app, restart it; otherwise run `npm start`.'
    : status === 403 ? 'Your account does not have permission for this. Ask an administrator.'
    : status === 429 ? 'Too many requests in a short time. Wait a minute and retry.'
    : status === 502 ? 'An upstream service (e.g. GitHub) returned an error. Check the integration settings and token permissions.'
    : 'If this keeps happening, check the server log for the request ID.';
  return (
    <div className="notice error" role="alert">
      <Icon name="critical" />
      <div className="stack" style={{ gap: 6 }}>
        <strong>{error.message}</strong>
        <span className="secondary">{hint}</span>
        {onRetry && (
          <div>
            <button className="btn btn-sm" onClick={onRetry}>
              <Icon name="refresh" size={14} /> Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon name={tone === 'error' ? 'critical' : tone === 'warn' ? 'warn' : 'info'} />
      <div>{children}</div>
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Callers usually pass an inline onClose; keep the latest in a ref so the effect runs once per open.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab' && ref.current) {
        const items = ref.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!items.length) return;
        const a = items[0]!;
        const b = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === a) (e.preventDefault(), b.focus());
        else if (!e.shiftKey && document.activeElement === b) (e.preventDefault(), a.focus());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} style={wide ? { width: 'min(860px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" data-close>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.id === value);
            if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length]!.id);
            if (e.key === 'ArrowLeft') onChange(tabs[(i - 1 + tabs.length) % tabs.length]!.id);
          }}
        >
          {t.label}
          {t.count !== undefined && <span className="muted"> ({t.count})</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, help, children, htmlFor }: { label: string; help?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help && <div className="help">{help}</div>}
    </div>
  );
}

export function Kpi({ label, value, meta, icon, drill }: { label: string; value: ReactNode; meta?: ReactNode; icon?: IconName; drill?: ReactNode }) {
  return (
    <div className="card kpi">
      <div className="label">
        {icon && <Icon name={icon} size={15} />}
        {label}
      </div>
      <div className="value">{value}</div>
      {meta && <div className="meta">{meta}</div>}
      {drill}
    </div>
  );
}

export function DataSourceNote({ children }: { children: ReactNode }) {
  return <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>{children}</p>;
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  return (
    <div className="spread" style={{ marginTop: 12 }}>
      <span className="muted">
        {offset + 1}–{Math.min(total, offset + limit)} of {total.toLocaleString()}
      </span>
      <div className="row">
        <button className="btn btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</button>
        <button className="btn btn-sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</button>
      </div>
    </div>
  );
}
