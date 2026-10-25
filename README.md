# SentinelOps

**AI-assisted DevOps intelligence for repositories, pipelines, security and live services — local-first, evidence-only.**

SentinelOps analyses GitHub repositories and local working copies, diagnoses failed GitHub Actions runs from their logs, scans for secrets and vulnerable dependencies, monitors websites and APIs, opens and verifies incidents, runs bounded load tests, and rolls everything into a documented health score. Every number on screen comes from a measurement or an authorised API; when data is missing the UI says *unknown* instead of inventing a value.

| | |
|---|---|
| Web app | React + Vite, responsive (phone → desktop), dark/light themes |
| Server | Node.js 24, Fastify, built-in `node:sqlite` (no external database) |
| Desktop | Windows `.exe` (Electron) running the server in-process on `127.0.0.1` |
| Auth | First-run setup token → admin account; scrypt passwords; HttpOnly SameSite=Strict sessions; CSRF; roles (admin / read-only viewer); **at most 3 accounts** (invitations reserve a seat) |
| Cost | ₹0 — runs locally; no paid services required |

## Features

- **Repository Manager** — GitHub or local folder; languages, frameworks, components, manifests, Docker/Terraform/Kubernetes, docs gaps; tabs for overview, architecture, dependencies, pipelines, security, PR gatekeeper, deployments, incidents, analytics, documentation.
- **CI/CD diagnostics** — syncs GitHub Actions runs, fetches failed job logs, finds the *first meaningful* error (ignores cascading `exit code 1` lines), classifies it (dependency, test, type, Docker, env, permission, network/upstream, OOM, timeout…), cites the log lines, suggests a minimal fix, and marks it **verified only when a later run of the same workflow on the same branch succeeds**.
- **PR Gatekeeper** — pass / warn / block per rule (CI checks, secrets in added lines, risky workflow/Docker/Terraform changes, dependency changes, missing tests, breaking-change heuristics, size). Never executes PR code; posting a PR comment is opt-in and confirmed each time.
- **Security Intelligence** — secret patterns (redacted, never stored), GitHub Actions hardening (unpinned actions, script injection, `pull_request_target` checkouts, token permissions), Dockerfile and IaC rules, OSV.dev advisories, Dependabot alerts, and Gitleaks/Trivy when installed. Suppressions require a written justification and are audited.
- **Live monitoring** — scheduled HTTP checks (≥ 60 s), retries, thresholds, TLS expiry, incidents with recovery verification; one-off public website scans (headers, TLS, DNS, redirects, cookies, technology indicators).
- **Response assertions** — e.g. `[BODY].status == "ok"`, `[RESPONSE_TIME] < 500ms`, `len([BODY].items) > 0`, `[HEADER].content-type matches "application/json*"`, `[CERT_EXPIRY] > 14d`; every check shows each assertion with its actual value. No `eval`, globs instead of regex, and anything incomparable *fails* rather than passing.
- **Recovery hysteresis** — open after N failures, auto-resolve only after M consecutive successes.
- **Heartbeat (push) monitors** — for cron jobs, backups and workers: the job calls a secret `/ping/<token>` URL (`/start`, `/fail`, `/<exit-code>` supported); if no ping arrives within timeout + grace, an incident opens. Tokens are stored only as SHA-256 hashes; pings are rate-limited.
- **Notifications** — incident opened/resolved alerts to any JSON webhook (Slack, Discord, ntfy…), stored AES-256-GCM-encrypted, delivered with SSRF protection (private networks blocked by default, connection pinned to the validated IP, no redirects) and retries.
- **Incidents** — automatic from monitors, failing default-branch workflows and critical findings; acknowledge, notes, resolve; measured time-to-detect and time-to-recover.
- **System Health Pulse** — weighted score from measured inputs only; withheld below 50 % input coverage. See [docs/HEALTH-SCORE.md](docs/HEALTH-SCORE.md).
- **Analytics** — CI success rate, build duration avg/p95, failure categories, MTTR/MTTD, deployment frequency and change-failure rate (heuristic, labelled), availability/latency, security trends, CSV export (formula-injection safe).
- **Load testing** — bounded closed-loop tests in a worker thread (local targets ≤ 200 VUs / 300 s; remote targets only if already monitored *and* ownership confirmed, ≤ 25 VUs / 60 s), auto-abort on error rate, p50/p95/p99, histogram, status codes; k6 summary import.
- **Live updates** — one Server-Sent Events stream per tab; no polling.

## Quick start (local)

Requirements: Node.js ≥ 24, npm ≥ 11, Windows/macOS/Linux.

```powershell
git clone https://github.com/mohamedwaseemgitx7-dotcom/dmonitz.git
cd dmonitz
npm ci
npm start                     # builds, then serves http://127.0.0.1:4600
```

On Windows you can instead double-click **`Start-SentinelOps.cmd`** — it installs dependencies on first run, builds, starts the server and opens the browser. (`npm run start:fast` skips the build when nothing changed.)

On first start the server prints a **one-time setup token** (also written to `data/setup-token.txt`). Open the app, paste the token, and create the administrator account with your own password. The token file is deleted once the account exists. There are no default credentials.

**GitHub access** (optional, read-only): either set `GITHUB_TOKEN` in a local `.env` (see [.env.example](.env.example)) or enable *Settings → Use my local GitHub CLI login* if you are signed in with `gh`. Tokens are never written to the database or logs.

Development with hot reload: `npm run dev` (server on :4600, UI on :5173 with an API proxy).

## Windows desktop app

```powershell
npm run desktop:build
```

Produces in `apps/desktop/release/`:

- `SentinelOps-0.1.0-x64-setup.exe` — per-user installer (no administrator rights), Start-menu and desktop shortcuts, normal uninstall via *Settings → Apps*. Silent install to a chosen folder: `SentinelOps-0.1.0-x64-setup.exe /S /D=D:\SentinelOps`.
- `SentinelOps-0.1.0-portable.exe` — run without installing.

The binaries are **not code-signed**. Run locally they start normally; a **downloaded** copy triggers SmartScreen ("Windows protected your PC"). Verify the SHA-256 against [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) before choosing *Run anyway*. The ₹0 way to remove the warning is publishing through the Microsoft Store — see [BUILD_WINDOWS.md](BUILD_WINDOWS.md). Data lives in `%APPDATA%\SentinelOps\data`; uninstalling keeps it unless you delete that folder.

## Testing

```powershell
npm run typecheck
npm test                 # unit + API + security tests (vitest)
npx playwright test      # browser e2e, desktop + mobile viewports (uses installed Chrome locally)
```

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Security plan](docs/SECURITY-PLAN.md) · [Test plan](docs/TEST-PLAN.md) · [Health score](docs/HEALTH-SCORE.md) · [Load-test results](docs/LOAD-TEST-RESULTS.md) · [Cost & quotas](docs/COST-AND-QUOTAS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Decisions](docs/DECISIONS.md) · [Project status](docs/PROJECT-STATUS.md) · [Release checklist](docs/RELEASE-CHECKLIST.md)

## Known limitations

- No scanner proves the absence of vulnerabilities; each analysis lists exactly which checks ran and which were skipped.
- Remote GitHub analysis secret-scans up to 150 prioritised files (one API call each); analyse a local clone for full coverage.
- Deployment frequency / change-failure rate are inferred from workflow names (deploy/release/publish) and labelled as heuristics.
- Measured capacity (≈ 1,800 req/s on the health endpoint on the development laptop) is **not** a statement about concurrent users — see [docs/LOAD-TEST-RESULTS.md](docs/LOAD-TEST-RESULTS.md).
- No AI provider is configured; diagnostics are deterministic.
- Free cloud hosts do not fit this architecture without trade-offs — see [docs/COST-AND-QUOTAS.md](docs/COST-AND-QUOTAS.md).

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
