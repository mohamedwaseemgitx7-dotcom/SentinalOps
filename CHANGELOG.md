# Changelog

## 0.1.0 — 2026-10-25

First working release (local-first).

### Added
- Fastify + SQLite server with first-run setup token, scrypt passwords, sessions, CSRF, roles, invites, audit log, rate limiting.
- Repository analysis for GitHub and local folders: architecture detection, secrets, GitHub Actions/Docker/Terraform/Kubernetes rules, hygiene, OSV.dev and Dependabot advisories, optional Gitleaks/Trivy.
- GitHub Actions sync, deterministic log diagnosis with cited evidence, fix verification, pipeline incidents.
- PR Gatekeeper (metadata/diff only; optional confirmed PR comment).
- Monitoring with incidents and recovery verification; public website scans.
- Bounded load testing in a worker thread; k6 summary import.
- System Health Pulse, analytics with CSV export, SSE live activity.
- Responsive React UI (dark/light), Windows desktop app (installer + portable).
- Vitest unit/API tests, Playwright e2e (desktop + mobile), GitHub Actions CI, Dockerfile.

### Fixed during live verification
- `/` returned 403 when serving the UI.
- Upstream HTTP failures (curl 5xx) misclassified as build errors.
- Health score shown as "100 healthy" with 29 % data coverage — now withheld below 50 %.
- Remote analysis took ~110 s — parallel reads, now ~14 s.
- Load tests could exhaust the UI's rate limit; worker thread never exited.
- Secret scanner false positives (key header without key body; plain words as passwords); OSV 400 on npm workspaces.
- Modal focus loss; unlabeled account button on mobile.
- Stale monitor check written into a new monitor that reused a deleted monitor's id (found by CI).
- CI: gitleaks action failed on the root commit (replaced by checksum-verified binary); npm cache path.
