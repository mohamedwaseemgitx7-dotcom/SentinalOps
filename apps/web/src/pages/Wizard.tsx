import { useState, type FormEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/icons';
import { Field, Modal, Notice } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useRouter } from '../lib/router';

type Kind = 'github' | 'local' | 'website' | 'monitor' | 'report';

const CHOICES: { kind: Kind; icon: IconName; title: string; desc: string }[] = [
  { kind: 'github', icon: 'github', title: 'GitHub repository', desc: 'Architecture, dependencies, security rules, workflow runs and failure diagnosis.' },
  { kind: 'local', icon: 'folder', title: 'Local repository folder', desc: 'Full secret scan and optional Gitleaks/Trivy on a working copy on this machine.' },
  { kind: 'website', icon: 'globe', title: 'Public website URL', desc: 'One-off check of TLS, DNS, headers, redirects and response time.' },
  { kind: 'monitor', icon: 'pulse', title: 'Website / API monitor', desc: 'Scheduled health checks with incidents and recovery verification.' },
  { kind: 'report', icon: 'upload', title: 'Previous test report', desc: 'Import a k6 summary export (JSON) as an external measurement.' },
];

const ACCESS: Record<Kind, ReactNode> = {
  github: (
    <>
      Uses read-only GitHub REST calls with the token configured on the server (<code>GITHUB_TOKEN</code> or your GitHub CLI login, if enabled in Settings). Needed scopes: <code>repo</code> (read) for private repos and <code>actions:read</code> for logs.
      Only metadata, findings and short redacted log excerpts are stored — not the source code.
    </>
  ),
  local: <>Reads files under the folder you choose (symlinks are not followed; node_modules, build output and .git are skipped). Nothing leaves this machine except, if enabled, package names and versions sent to OSV.dev.</>,
  website: <>Makes the same requests any visitor would: the page, <code>/robots.txt</code> and <code>/.well-known/security.txt</code>. It cannot see source code, CI/CD or server internals.</>,
  monitor: <>Requests the URL on your chosen interval (minimum 60 s). Only monitor services you own or are authorised to check.</>,
  report: <>The JSON file is parsed in your browser and only the summary metrics are stored.</>,
};

export function AddSourceWizard({ onClose, initial }: { onClose: () => void; initial?: Kind }) {
  const [kind, setKind] = useState<Kind | null>(initial ?? null);
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [interval, setIntervalS] = useState(300);
  const [osv, setOsv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const { navigate } = useRouter();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!kind) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'github' || kind === 'local') {
        const r = await api.post<{ id: number }>('/api/repositories', { kind, ref: value, analyze: true, dependencyAdvisories: osv });
        onClose();
        navigate(`/repositories/${r.id}`);
      } else if (kind === 'website') {
        const r = await api.post<{ id: number }>('/api/sites/scan', { url: value });
        onClose();
        navigate(`/monitoring/scan/${r.id}`);
      } else if (kind === 'monitor') {
        const r = await api.post<{ id: number }>('/api/monitors', { name: name || new URL(value).host, url: value, intervalS: interval });
        onClose();
        navigate(`/monitoring/${r.id}`);
      } else if (kind === 'report') {
        if (!file) throw new Error('Choose a k6 summary JSON file.');
        if (file.size > 4 * 1024 * 1024) throw new Error('File is larger than 4 MB.');
        const summary = JSON.parse(await file.text()) as Record<string, unknown>;
        const r = await api.post<{ id: number }>('/api/load-tests/import-k6', { target: value, notes: `Imported from ${file.name}`, summary });
        onClose();
        navigate(`/load-tests/${r.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={kind ? CHOICES.find((c) => c.kind === kind)!.title : 'What do you want to analyze?'}
      onClose={onClose}
      footer={kind && (
        <>
          {!initial && <button className="btn" type="button" onClick={() => (setKind(null), setError(null))}>Back</button>}
          <button className="btn btn-primary" form="wizard-form" disabled={busy}>{busy ? 'Working…' : kind === 'website' ? 'Scan now' : kind === 'monitor' ? 'Start monitoring' : kind === 'report' ? 'Import' : 'Connect & analyze'}</button>
        </>
      )}
    >
      <div className="steps" aria-hidden="true"><span className="on" /><span className={kind ? 'on' : ''} /></div>
      {!kind ? (
        <div className="stack">
          {CHOICES.map((c) => (
            <button key={c.kind} className="choice" onClick={() => setKind(c.kind)} type="button">
              <span className="ic"><Icon name={c.icon} /></span>
              <span>
                <strong style={{ display: 'block' }}>{c.title}</strong>
                <span className="secondary" style={{ fontSize: 13 }}>{c.desc}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <form id="wizard-form" className="stack" style={{ gap: 14 }} onSubmit={submit}>
          {kind === 'github' && (
            <Field label="Repository" htmlFor="w-value" help="owner/name or https://github.com/owner/name">
              <input id="w-value" className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="octocat/hello-world" required autoFocus />
            </Field>
          )}
          {kind === 'local' && (
            <Field label="Folder path on this computer" htmlFor="w-value" help="e.g. D:\Projects\my-app">
              <input id="w-value" className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="D:\Projects\my-app" required spellCheck={false} autoFocus />
            </Field>
          )}
          {(kind === 'website' || kind === 'monitor') && (
            <Field label="URL" htmlFor="w-value">
              <input id="w-value" className="input" type="url" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://example.com/health" required autoFocus />
            </Field>
          )}
          {kind === 'monitor' && (
            <div className="grid grid-2">
              <Field label="Name" htmlFor="w-name"><input id="w-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production API" /></Field>
              <Field label="Check every" htmlFor="w-int">
                <select id="w-int" className="input" value={interval} onChange={(e) => setIntervalS(Number(e.target.value))}>
                  {[60, 120, 300, 600, 1800, 3600].map((s) => <option key={s} value={s}>{s < 3600 ? `${s / 60} min` : '1 hour'}</option>)}
                </select>
              </Field>
            </div>
          )}
          {kind === 'report' && (
            <>
              <Field label="Target that was tested" htmlFor="w-value"><input id="w-value" className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://staging.example.com" required /></Field>
              <Field label="k6 summary file" htmlFor="w-file" help="Produced with k6 run --summary-export=summary.json"><input id="w-file" type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></Field>
            </>
          )}
          {(kind === 'github' || kind === 'local') && (
            <label className="check">
              <input type="checkbox" checked={osv} onChange={(e) => setOsv(e.target.checked)} />
              <span>Check dependencies against OSV.dev advisories. <span className="muted">Sends only package names and versions to the public OSV API (operated by Google). No source code is sent.</span></span>
            </label>
          )}
          <Notice tone="info"><strong>Access required: </strong>{ACCESS[kind]}</Notice>
          {error && <Notice tone="error">{error}</Notice>}
        </form>
      )}
    </Modal>
  );
}
