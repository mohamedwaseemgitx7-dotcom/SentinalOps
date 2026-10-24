import { useState, type FormEvent } from 'react';
import { Icon, Logo } from '../components/icons';
import type { SessionUser } from '../components/Shell';
import { Field, Notice } from '../components/ui';
import { api, ApiError } from '../lib/api';

type Mode = 'login' | 'setup' | 'invite';

declare global {
  interface Window {
    sentinelDesktop?: { getSetupToken: () => Promise<string | null>; version: string };
  }
}

export function AuthPage({ mode, onAuthenticated }: { mode: Mode; onAuthenticated: (user: SessionUser, csrf: string) => void }) {
  const params = new URLSearchParams(window.location.search);
  const [username, setUsername] = useState(mode === 'setup' ? 'mohamedwaseem' : '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState(params.get('token') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  const strength = password.length >= 16 ? 'strong' : password.length >= 12 ? 'ok' : 'weak';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode !== 'login' && password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      const url = mode === 'login' ? '/api/auth/login' : mode === 'setup' ? '/api/auth/setup' : '/api/auth/accept-invite';
      const body = mode === 'login' ? { username, password } : { username, password, token };
      const res = await api.post<{ user: SessionUser; csrfToken: string }>(url, body);
      window.history.replaceState(null, '', '/');
      onAuthenticated(res.user, res.csrfToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'login' ? 'Sign in to SentinelOps' : mode === 'setup' ? 'Create the administrator account' : 'Accept your invitation';
  return (
    <div className="auth-page">
      <div className="card auth-card" style={{ padding: 28 }}>
        <div className="row" style={{ marginBottom: 22 }}>
          <div className="brand-mark"><Logo size={19} /></div>
          <div>
            <div className="brand-name">SentinelOps</div>
            <div className="brand-sub">DevOps intelligence platform</div>
          </div>
        </div>
        <h1 style={{ fontSize: 20, marginBottom: 6 }}>{title}</h1>
        {mode === 'setup' && (
          <p className="secondary" style={{ marginBottom: 16, fontSize: 13 }}>
            First run. Enter the one-time setup token printed in the server console (also saved to <code>setup-token.txt</code> in the data folder). No default password exists.
          </p>
        )}
        <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
          {mode !== 'login' && (
            <Field label={mode === 'setup' ? 'Setup token' : 'Invitation token'} htmlFor="token">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input id="token" className="input" style={{ flex: 1 }} value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" spellCheck={false} />
                {mode === 'setup' && window.sentinelDesktop && (
                  <button type="button" className="btn" onClick={async () => setToken((await window.sentinelDesktop!.getSetupToken()) ?? '')}>Fill</button>
                )}
              </div>
            </Field>
          )}
          <Field label="Username" htmlFor="username">
            <input id="username" className="input" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" autoFocus={mode === 'login'} />
          </Field>
          <Field label="Password" htmlFor="password" help={mode !== 'login' ? `At least 12 characters; a passphrase is best. Strength: ${strength}.` : undefined}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input id="password" className="input" style={{ flex: 1 }} type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'login' ? 1 : 12} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
              <button type="button" className="btn" onClick={() => setShow((s) => !s)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
            </div>
          </Field>
          {mode !== 'login' && (
            <Field label="Confirm password" htmlFor="confirm">
              <input id="confirm" className="input" type={show ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
            </Field>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <button className="btn btn-primary" disabled={busy} style={{ height: 40 }}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'} {!busy && <Icon name="check" size={16} />}
          </button>
        </form>
        <p className="muted" style={{ fontSize: 12, marginTop: 18 }}>
          Sessions use HttpOnly, SameSite=Strict cookies. Repeated failed attempts are rate-limited and lock the account temporarily.
        </p>
      </div>
    </div>
  );
}
