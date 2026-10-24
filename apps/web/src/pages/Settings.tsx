import { useState, type FormEvent } from 'react';
import { Badge, Card, DataSourceNote, ErrorState, Field, LoadingBlock, Notice } from '../components/ui';
import type { SessionUser } from '../components/Shell';
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
  const { data, reload } = useResource<{ users: { id: number; username: string; role: string; created_at: string; last_login_at: string | null }[] }>('/api/users');
  const [role, setRole] = useState('viewer');
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Users" hint="Viewers can read everything but cannot change anything">
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
        <button className="btn" onClick={async () => { const r = await api.post<{ token: string }>('/api/users/invites', { role }); setLink(`${window.location.origin}/invite?token=${encodeURIComponent(r.token)}`); }}>Create invitation link</button>
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
