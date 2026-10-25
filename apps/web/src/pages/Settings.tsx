import { useState, type FormEvent } from 'react';
import { Badge, Card, DataSourceNote, ErrorState, Field, LoadingBlock, Notice } from '../components/ui';
import type { SessionUser } from '../components/Shell';
import { Icon } from '../components/icons';
import { api, ApiError } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { useResource } from '../lib/live';

interface Settings {
  github: { tokenSource: 'env' | 'gh-cli' | 'none'; useGhCli: boolean; envTokenConfigured: boolean; rateLimit: { limit: number | null; remaining: number | null; resetAt: string | null } };
  gatekeeper: { allowComments: boolean };
  ai: { provider: string | null; status: string; note: string };
  dataDir: string;
  secureCookies: boolean;
}

interface SystemInfo {
  version: string;
  startedAt: string;
  node: string;
  platform: string;
  memoryMb: number;
  scanners: { name: string; available: boolean; version: string | null }[];
  db: { checks: number; runs: number; findings: number; events: number };
}

export function SettingsPage({ user }: { user: SessionUser }) {
  const isAdmin = user.role === 'admin';
  const settings = useResource<Settings>('/api/settings');
  const system = useResource<SystemInfo>('/api/system');
  const [err, setErr] = useState<string | null>(null);
  const update = async (patch: Record<string, boolean>) => {
    setErr(null);
    try {
      await api.put('/api/settings', patch);
      settings.reload();
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><p className="sub">Integrations, account security, users and audit trail.</p></div></div>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="grid grid-2">
        <Card title="GitHub integration" id="integrations">
          {settings.error ? <ErrorState error={settings.error} /> : !settings.data ? <LoadingBlock /> : (
            <div className="stack">
              <div className="row">Credential source: <Badge tone={settings.data.github.tokenSource === 'none' ? 'warning' : 'good'}>{settings.data.github.tokenSource === 'env' ? 'GITHUB_TOKEN environment variable' : settings.data.github.tokenSource === 'gh-cli' ? 'GitHub CLI login' : 'None (public data only, 60 req/h)'}</Badge></div>
              {settings.data.github.rateLimit.limit !== null && <p className="secondary">API quota: {settings.data.github.rateLimit.remaining} of {settings.data.github.rateLimit.limit} remaining, resets {timeAgo(settings.data.github.rateLimit.resetAt)}.</p>}
              <label className="check">
                <input type="checkbox" disabled={!isAdmin || settings.data.github.envTokenConfigured} checked={settings.data.github.useGhCli} onChange={(e) => update({ useGhCli: e.target.checked })} />
                <span>Use my local GitHub CLI login (<code>gh auth token</code>). <span className="muted">The token is read on demand, held in memory for 10 minutes, and never written to disk, the database or logs.</span></span>
              </label>
              <label className="check">
                <input type="checkbox" disabled={!isAdmin} checked={settings.data.gatekeeper.allowComments} onChange={(e) => update({ allowPrComments: e.target.checked })} />
                <span>Allow PR Gatekeeper to post comments (each post still asks for confirmation).</span>
              </label>
              <DataSourceNote>For least privilege, prefer a fine-grained token with read-only Contents, Metadata and Actions permissions. Never paste tokens into chat or commit them.</DataSourceNote>
            </div>
          )}
        </Card>
        <Card title="AI-assisted troubleshooting">
          {settings.data && (
            <div className="stack">
              <Badge tone="unknown">Not configured</Badge>
              <p className="secondary">{settings.data.ai.note}</p>
              <DataSourceNote>An optional provider can be added later. Before any repository content, logs or findings are sent, SentinelOps will show exactly what will be sent and require explicit approval. AI output will always be labelled as a suggestion until independently verified.</DataSourceNote>
            </div>
          )}
        </Card>
        <ChangePassword />
        <Card title="System">
          {!system.data ? <LoadingBlock /> : (
            <dl className="dl">
              <dt>Version</dt><dd>{system.data.version}</dd>
              <dt>Runtime</dt><dd>Node {system.data.node} · {system.data.platform}</dd>
              <dt>Started</dt><dd>{dateTime(system.data.startedAt)}</dd>
              <dt>Memory</dt><dd>{system.data.memoryMb} MB RSS</dd>
              <dt>Stored</dt><dd>{system.data.db.runs.toLocaleString()} runs · {system.data.db.findings.toLocaleString()} findings · {system.data.db.checks.toLocaleString()} checks</dd>
              <dt>Data folder</dt><dd className="mono">{settings.data?.dataDir}</dd>
              <dt>Cookies</dt><dd>{settings.data?.secureCookies ? 'Secure (HTTPS)' : 'Local HTTP — set SENTINELOPS_SECURE_COOKIES=true behind HTTPS'}</dd>
              <dt>External scanners</dt><dd>{system.data.scanners.map((s) => <span key={s.name} style={{ marginRight: 8 }}><Badge tone={s.available ? 'good' : 'unknown'}>{s.name}: {s.available ? s.version : 'not installed'}</Badge></span>)}</dd>
            </dl>
          )}
        </Card>
      </div>
      {isAdmin && <ChannelsCard />}
      {isAdmin && <Users me={user} />}
      {isAdmin && <AuditLog />}
    </>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setMsg({ tone: 'error', text: 'New passwords do not match.' });
    try {
      await api.post('/api/auth/password', { currentPassword: current, newPassword: next });
      setMsg({ tone: 'info', text: 'Password changed. All other sessions were signed out.' });
      setCurrent(''); setNext(''); setConfirm('');
    } catch (er) {
      setMsg({ tone: 'error', text: (er as ApiError).message });
    }
  }
  return (
    <Card title="Change password">
      <form className="stack" onSubmit={submit}>
        <Field label="Current password" htmlFor="cp-cur"><input id="cp-cur" type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required /></Field>
        <Field label="New password" htmlFor="cp-new" help="At least 12 characters."><input id="cp-new" type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={12} required /></Field>
        <Field label="Confirm new password" htmlFor="cp-conf"><input id="cp-conf" type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required /></Field>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div><button className="btn btn-primary">Update password</button></div>
      </form>
    </Card>
  );
}

function Users({ me }: { me: SessionUser }) {
  const { data, reload } = useResource<{ users: { id: number; username: string; role: string; created_at: string; last_login_at: string | null }[]; maxUsers: number; seats: { users: number; pendingInvites: number } }>('/api/users');
  const seatsTaken = data ? data.seats.users + data.seats.pendingInvites : 0;
  const full = !!data && seatsTaken >= data.maxUsers;
  const [role, setRole] = useState('viewer');
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Users" hint={data ? `${seatsTaken} of ${data.maxUsers} seats used (${data.seats.pendingInvites} pending invitation${data.seats.pendingInvites === 1 ? '' : 's'}) · viewers are read-only` : 'Viewers are read-only'}>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="table-wrap"><table>
        <thead><tr><th>User</th><th>Role</th><th>Created</th><th>Last sign-in</th><th /></tr></thead>
        <tbody>{data?.users.map((u) => (
          <tr key={u.id}><td>{u.username}{u.id === me.id && <span className="muted"> (you)</span>}</td><td><Badge tone={u.role === 'admin' ? 'accent' : 'unknown'} icon={false}>{u.role}</Badge></td><td>{dateTime(u.created_at)}</td><td>{timeAgo(u.last_login_at)}</td>
            <td>{u.id !== me.id && <button className="btn btn-sm btn-danger" onClick={async () => { try { await api.del(`/api/users/${u.id}`); reload(); } catch (e) { setErr((e as ApiError).message); } }}>Remove</button>}</td></tr>
        ))}</tbody>
      </table></div>
      <div className="row" style={{ marginTop: 14 }}>
        <label htmlFor="inv-role" className="secondary">Invite a</label>
        <select id="inv-role" className="input" style={{ width: 140 }} value={role} onChange={(e) => setRole(e.target.value)}><option value="viewer">viewer</option><option value="admin">administrator</option></select>
        <button className="btn" disabled={full} onClick={async () => { setErr(null); try { const r = await api.post<{ token: string }>('/api/users/invites', { role }); setLink(`${window.location.origin}/invite?token=${encodeURIComponent(r.token)}`); reload(); } catch (e) { setErr((e as ApiError).message); } }}>Create invitation link</button>
        {full && <span className="muted" style={{ fontSize: 12 }}>All seats are in use — SentinelOps allows at most 3 accounts.</span>}
      </div>
      {link && <Notice tone="info">Single-use link, valid 24 hours. Share it privately: <code style={{ overflowWrap: 'anywhere' }}>{link}</code></Notice>}
    </Card>
  );
}

function AuditLog() {
  const { data } = useResource<{ entries: { id: number; ts: string; username: string | null; action: string; target: string | null; detail: string | null; ip: string | null }[] }>('/api/audit?limit=100');
  return (
    <Card title="Audit log" id="audit" hint="Security-relevant actions, newest first">
      {!data ? <LoadingBlock /> : (
        <div className="table-wrap" style={{ maxHeight: 420 }}><table>
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th className="hide-sm">Detail</th><th className="hide-sm">IP</th></tr></thead>
          <tbody>{data.entries.map((e) => <tr key={e.id}><td className="muted">{dateTime(e.ts)}</td><td>{e.username ?? '—'}</td><td className="mono">{e.action}</td><td className="truncate" style={{ maxWidth: 200 }}>{e.target ?? ''}</td><td className="hide-sm secondary truncate" style={{ maxWidth: 260 }}>{e.detail ?? ''}</td><td className="hide-sm mono">{e.ip}</td></tr>)}</tbody>
        </table></div>
      )}
    </Card>
  );
}

interface Channel {
  id: number;
  name: string;
  target_hint: string;
  allow_private: number;
  enabled: number;
  last_sent_at: string | null;
  last_error: string | null;
}

/** Incident alerts to Slack, Discord, ntfy, Teams-compatible or any JSON webhook. */
function ChannelsCard() {
  const { data, reload } = useResource<{ channels: Channel[]; recent: { id: number; event: string; status: string; attempts: number; error: string | null; created_at: string; channel: string }[] }>('/api/channels');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: 'info', text: ok });
      reload();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as ApiError).message });
    }
  };
  return (
    <Card title="Notification channels" id="channels" hint="Sent when an incident opens or resolves">
      <div className="stack">
        {data?.channels.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Channel</th><th>Target</th><th>Status</th><th /></tr></thead>
            <tbody>{data.channels.map((c) => (
              <tr key={c.id}>
                <td>{c.name}{c.allow_private ? <div className="muted" style={{ fontSize: 11.5 }}>private network allowed</div> : null}</td>
                <td className="mono">{c.target_hint}</td>
                <td>{!c.enabled ? <Badge tone="unknown">disabled</Badge> : c.last_error ? <Badge tone="critical">error</Badge> : c.last_sent_at ? <Badge tone="good">sent {timeAgo(c.last_sent_at)}</Badge> : <Badge tone="unknown">not used yet</Badge>}{c.last_error && <div style={{ color: 'var(--critical-text)', fontSize: 11.5 }}>{c.last_error}</div>}</td>
                <td><div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <button className="btn btn-sm" onClick={() => act(async () => { const r = await api.post<{ status: string; error: string | null }>(`/api/channels/${c.id}/test`); if (r.status !== 'sent') throw new Error(`Test not delivered: ${r.error ?? r.status}`); }, `Test message delivered to "${c.name}".`)}>Test</button>
                  <button className="btn btn-sm" onClick={() => act(() => api.put(`/api/channels/${c.id}`, { enabled: !c.enabled }))}>{c.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="btn btn-sm btn-danger" aria-label={`Delete ${c.name}`} onClick={() => act(() => api.del(`/api/channels/${c.id}`))}><Icon name="trash" size={13} /></button>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p className="muted">No channels yet. Add a webhook to get incident alerts on your phone (e.g. a Discord or Slack webhook, or an ntfy.sh topic URL).</p>}
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.post('/api/channels', { name, url, allowPrivate }); setName(''); setUrl(''); setAllowPrivate(false); }, 'Channel added — use Test to verify it.'); }}>
          <div className="grid grid-2">
            <Field label="Name" htmlFor="ch-name"><input id="ch-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My phone (ntfy)" required /></Field>
            <Field label="Webhook URL" htmlFor="ch-url" help="Stored encrypted; only the host is shown afterwards"><input id="ch-url" className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://ntfy.sh/your-secret-topic" required /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={allowPrivate} onChange={(e) => setAllowPrivate(e.target.checked)} /> <span>Allow private-network targets (e.g. a self-hosted ntfy on your LAN). <span className="muted">Off by default to prevent requests to internal services.</span></span></label>
          <div><button className="btn" disabled={!name.trim() || !url.trim()}>Add channel</button></div>
        </form>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {data?.recent.length ? (
          <details>
            <summary className="secondary" style={{ cursor: 'pointer', fontSize: 13 }}>Recent deliveries</summary>
            <div className="table-wrap" style={{ marginTop: 8 }}><table>
              <tbody>{data.recent.map((n) => <tr key={n.id}><td className="muted">{timeAgo(n.created_at)}</td><td>{n.channel}</td><td className="mono">{n.event}</td><td><Badge tone={n.status === 'sent' ? 'good' : n.status === 'failed' ? 'critical' : 'warning'}>{n.status}</Badge></td><td className="secondary">{n.error ?? ''}</td></tr>)}</tbody>
            </table></div>
          </details>
        ) : null}
        <DataSourceNote>Payload: JSON with <code>event</code>, <code>incident</code> and a <code>text</code>/<code>content</code> summary, so Slack, Discord and ntfy display it directly. Redirects are not followed; failed deliveries retry twice.</DataSourceNote>
      </div>
    </Card>
  );
}
