import { useId, useRef, useState, type ReactNode } from 'react';

/* Charts follow the dataviz method: thin marks, recessive grid, one axis, legend for
 * ≥2 series, hover tooltips, and a table view so nothing depends on colour alone. */

interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

function useTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const node = tip ? (
    <div className="chart-tooltip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 270), top: tip.y + 14 }} role="status">
      {tip.content}
    </div>
  ) : null;
  return { show: (e: { clientX: number; clientY: number }, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content }), hide: () => setTip(null), node };
}

function TableToggle({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="link-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} data table
      </button>
      {open && (
        <div className="table-wrap" style={{ marginTop: 8, maxHeight: 260, overflow: 'auto' }}>
          <table aria-label={label}>{children}</table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health ring — a single headline value, so a stat ring with a status label.
// ---------------------------------------------------------------------------
export function HealthRing({ score, status, size = 200, partial, coverage = 0 }: { score: number | null; status: string; size?: number; partial: boolean; coverage?: number }) {
  const r = size / 2 - 14;
  const c = 2 * Math.PI * r;
  const frac = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const color = status === 'healthy' ? 'var(--good)' : status === 'warning' ? 'var(--warning)' : status === 'critical' ? 'var(--critical)' : 'var(--unknown)';
  const gradId = useId();
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={score === null ? `Health score not calculated: only ${Math.round(coverage * 100)}% of inputs have data` : `Health score ${score} of 100, ${status}${partial ? ', partial data' : ''}`}>
      <defs>
        <linearGradient id={gradId} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="1" />
          <stop offset="100%" stopColor={color} stopOpacity="0.65" />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={12} />
      {frac > 0 && (
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${gradId})`} strokeWidth={12} strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text x="50%" y="47%" textAnchor="middle" dominantBaseline="middle" fill="var(--text-primary)" fontSize={size * 0.24} fontWeight={700} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {score === null ? '—' : score}
      </text>
      <text x="50%" y="66%" textAnchor="middle" fill="var(--text-secondary)" fontSize={13} fontWeight={600} style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {score === null ? 'Insufficient data' : status}
      </text>
      {score === null && coverage > 0 && (
        <text x="50%" y="76%" textAnchor="middle" fill="var(--text-muted)" fontSize={11}>{Math.round(coverage * 100)}% of inputs measured</text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Stacked daily bars (e.g. CI successes vs failures)
// ---------------------------------------------------------------------------
export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

export function StackedBars<T extends Record<string, unknown>>({ data, xKey, series, height = 220, xFormat, ariaLabel }: { data: T[]; xKey: keyof T; series: StackSeries[]; height?: number; xFormat?: (v: string) => string; ariaLabel: string }) {
  const tip = useTooltip();
  const wrap = useRef<HTMLDivElement>(null);
  const W = 720;
  const H = height;
  const pad = { l: 34, r: 8, t: 10, b: 26 };
  const totals = data.map((d) => series.reduce((a, s) => a + (Number(d[s.key]) || 0), 0));
  const max = Math.max(1, ...totals);
  const niceMax = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const bw = (W - pad.l - pad.r) / Math.max(1, data.length);
  const barW = Math.max(3, Math.min(28, bw * 0.62));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / niceMax);
  const ticks = [0, niceMax / 2, niceMax].map((v) => Math.round(v));
  const labelEvery = Math.ceil(data.length / 8);
  return (
    <div ref={wrap}>
      <div className="legend" style={{ marginBottom: 8 }}>
        {series.map((s) => (
          <span key={s.key}><span className="sw" style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={ariaLabel} preserveAspectRatio="none" style={{ overflow: 'visible' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={pad.l - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fill="var(--text-muted)" fontSize={11}>{t}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.l + bw * i + bw / 2;
          let acc = 0;
          const segs = series.map((s) => {
            const v = Number(d[s.key]) || 0;
            const y0 = y(acc);
            acc += v;
            return { s, v, y0, y1: y(acc) };
          }).filter((x) => x.v > 0);
          return (
            <g
              key={i}
              onMouseMove={(e) => tip.show(e, (
                <div>
                  <strong>{xFormat ? xFormat(String(d[xKey])) : String(d[xKey])}</strong>
                  {series.map((s) => (
                    <div key={s.key}><span className="sw" style={{ background: s.color, display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6 }} />{s.label}: {String(d[s.key] ?? 0)}</div>
                  ))}
                </div>
              ))}
              onMouseLeave={tip.hide}
            >
              <rect x={cx - bw / 2} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {segs.map(({ s, y0, y1 }, si) => {
                const top = si === segs.length - 1;
                const h = Math.max(0, y0 - y1 - (si > 0 ? 2 : 0));
                return top ? (
                  <path key={s.key} d={roundedTop(cx - barW / 2, y1, barW, h, Math.min(4, barW / 2))} fill={s.color} />
                ) : (
                  <rect key={s.key} x={cx - barW / 2} y={y1} width={barW} height={h} fill={s.color} />
                );
              })}
              {i % labelEvery === 0 && (
                <text x={cx} y={H - 6} textAnchor="middle" fill="var(--text-muted)" fontSize={11}>{xFormat ? xFormat(String(d[xKey])) : String(d[xKey])}</text>
              )}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" />
      </svg>
      {tip.node}
      <TableToggle label={ariaLabel}>
        <thead><tr><th>{String(xKey)}</th>{series.map((s) => <th key={s.key} className="num">{s.label}</th>)}</tr></thead>
        <tbody>{data.map((d, i) => <tr key={i}><td>{String(d[xKey])}</td>{series.map((s) => <td key={s.key} className="num">{String(d[s.key] ?? 0)}</td>)}</tr>)}</tbody>
      </TableToggle>
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  const rr = Math.min(r, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

// ---------------------------------------------------------------------------
// Single-series line chart with crosshair tooltip
// ---------------------------------------------------------------------------
export function LineChart({ points, height = 180, color = 'var(--series-1)', yFormat = (v) => String(Math.round(v)), xFormat = (v) => v, ariaLabel, threshold, gaps }: {
  points: { x: string; y: number | null }[];
  height?: number;
  color?: string;
  yFormat?: (v: number) => string;
  xFormat?: (v: string) => string;
  ariaLabel: string;
  threshold?: { value: number; label: string };
  /** Marks points (e.g. failed checks) drawn below the line as ticks. */
  gaps?: boolean[];
}) {
  const tip = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = height;
  const pad = { l: 46, r: 10, t: 10, b: 24 };
  const vals = points.map((p) => p.y).filter((v): v is number => v !== null);
  const max = Math.max(1, threshold?.value ?? 0, ...vals) * 1.1;
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * i) / Math.max(1, points.length - 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  let d = '';
  points.forEach((p, i) => {
    if (p.y === null) return;
    d += `${d && points[i - 1]?.y !== null ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)} `;
  });
  const svgRef = useRef<SVGSVGElement>(null);
  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((rel - pad.l) / (W - pad.l - pad.r)) * (points.length - 1))));
    setHover(i);
    const p = points[i]!;
    tip.show(e, <div><strong>{xFormat(p.x)}</strong><div>{p.y === null ? 'No data' : yFormat(p.y)}{gaps?.[i] ? ' · failed' : ''}</div></div>);
  };
  return (
    <div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={ariaLabel} onMouseMove={onMove} onMouseLeave={() => (setHover(null), tip.hide())}>
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={pad.l - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fill="var(--text-muted)" fontSize={11}>{yFormat(t)}</text>
          </g>
        ))}
        {threshold && (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={y(threshold.value)} y2={y(threshold.value)} stroke="var(--warning)" strokeDasharray="4 4" strokeWidth={1.2} />
            <text x={W - pad.r} y={y(threshold.value) - 5} textAnchor="end" fill="var(--text-secondary)" fontSize={11}>{threshold.label}</text>
          </g>
        )}
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {gaps?.map((g, i) => g ? <rect key={i} x={x(i) - 1.5} y={H - pad.b - 8} width={3} height={8} fill="var(--critical)" rx={1} /> : null)}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--border-strong)" />
            {points[hover]?.y !== null && points[hover] && <circle cx={x(hover)} cy={y(points[hover]!.y!)} r={4} fill={color} stroke="var(--surface-1)" strokeWidth={2} />}
          </g>
        )}
        {points.length > 1 && [0, Math.floor(points.length / 2), points.length - 1].map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} fill="var(--text-muted)" fontSize={11}>{xFormat(points[i]!.x)}</text>
        ))}
      </svg>
      {tip.node}
      <TableToggle label={ariaLabel}>
        <thead><tr><th>Time</th><th className="num">Value</th></tr></thead>
        <tbody>{points.map((p, i) => <tr key={i}><td>{xFormat(p.x)}</td><td className="num">{p.y === null ? '—' : yFormat(p.y)}{gaps?.[i] ? ' (failed)' : ''}</td></tr>)}</tbody>
      </TableToggle>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars for ranked categories (failure categories, severities)
// ---------------------------------------------------------------------------
export function HBars({ rows, color = 'var(--series-1)', valueFormat = (v) => String(v), ariaLabel }: { rows: { label: string; value: number; tone?: string }[]; color?: string; valueFormat?: (v: number) => string; ariaLabel: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div role="list" aria-label={ariaLabel} className="stack" style={{ gap: 8 }}>
      {rows.map((r) => (
        <div role="listitem" key={r.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 38%) 1fr auto', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
          <span className="secondary truncate" title={r.label}>{r.label}</span>
          <span style={{ height: 10, background: 'var(--surface-3)', borderRadius: 4, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${(r.value / max) * 100}%`, background: r.tone ?? color, borderRadius: 4 }} />
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'right' }}>{valueFormat(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status strip: one cell per check (up/down), used for monitor history
// ---------------------------------------------------------------------------
export function StatusStrip({ items, ariaLabel }: { items: { ok: number; ts: string; latency_ms?: number | null }[]; ariaLabel: string }) {
  const tip = useTooltip();
  if (!items.length) return <span className="muted" style={{ fontSize: 12 }}>No checks yet</span>;
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 22 }} role="img" aria-label={`${ariaLabel}: ${items.filter((i) => i.ok).length} of ${items.length} checks passed`}>
      {items.map((it, i) => (
        <span
          key={i}
          onMouseMove={(e) => tip.show(e, <div><strong>{it.ok ? 'Up' : 'Down'}</strong><div>{new Date(it.ts).toLocaleString()}</div>{it.latency_ms != null && <div>{it.latency_ms} ms</div>}</div>)}
          onMouseLeave={tip.hide}
          style={{ flex: 1, minWidth: 3, maxWidth: 8, height: it.ok ? 22 : 14, borderRadius: 2, background: it.ok ? 'var(--series-1)' : 'var(--critical)' }}
        />
      ))}
      {tip.node}
    </div>
  );
}
