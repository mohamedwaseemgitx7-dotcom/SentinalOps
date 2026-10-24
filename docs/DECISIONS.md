# Architecture decision records

## ADR-001 Local-first, single process, SQLite (2026-10-24)
**Decision:** One Node.js process with Fastify and the built-in `node:sqlite` (WAL). **Why:** ₹0 budget, no external database (Supabase excluded), works identically on the desktop and a server, no native modules to compile. **Trade-off:** single-writer database and one process; horizontal scaling would need Postgres and scheduler leadership (documented, not built).

## ADR-002 Electron over Tauri for the desktop app (2026-10-24)
**Decision:** Electron 44 with the server running in the main process. **Why:** C: had 11.4 GB free; Tauri needs the Rust toolchain and MSVC build tools (several GB on C:). Electron reuses the exact Node server code and its Node 24.22 runtime supports `node:sqlite`. **Trade-off:** ~121 MB installer. Mitigated by sandboxed renderer, loopback-only server, no Node in the renderer.

## ADR-003 Deterministic diagnostics first, AI optional (2026-10-24)
**Decision:** CI diagnosis, findings and recommendations are rule-based and cite evidence. No AI provider is configured. **Why:** verifiable output, no data leaves the machine, no cost. If added later: opt-in, explicit disclosure of what is sent, outputs labelled as suggestions; the most capable model (`claude-opus-5-5`) would be the default for accuracy.

## ADR-004 Build-in security rules + OSV, external scanners when present (2026-10-24)
**Decision:** Built-in rules for secrets, GitHub Actions, Docker, Terraform, Kubernetes, hygiene; OSV.dev for advisories; Gitleaks/Trivy run automatically on local repos when installed. **Why:** works out of the box without installing system tools; every analysis lists checks that ran or were skipped.

## ADR-005 Dependency pinning policy (2026-10-24)
**Decision:** Exact versions published ≥ 14 days earlier (e.g. Electron 44.7.0 instead of 45.0.0 released 3 days before). **Exception:** security patches — `npm audit` flagged Electron (GHSA-jr5w-w6x2-84p9), Fastify (GHSA-389g-gv7q-r4x8) and Zod (GHSA-mrhx-c7xc-m3w5); upgraded to 44.9.3 / 5.12.7 / 4.6.7 immediately.

## ADR-006 Health score withheld below 50 % coverage (2026-10-25)
**Context:** Live testing showed "100 HEALTHY" when only the incidents input had data. **Decision:** Exclude unknown inputs, re-normalise, and produce no score below 50 % coverage. See HEALTH-SCORE.md.

## ADR-007 Rate limiting keyed by session (2026-10-25)
**Context:** A local load test shared the browser's IP and locked the UI out. **Decision:** 600 req/min per session (per IP when anonymous); `/api/health` exempt; login 10/min/IP separately.

## ADR-008 Server-Sent Events instead of polling (2026-10-24)
**Decision:** One SSE stream per tab carries activity events and cache-invalidation topics; pages refetch only what changed (debounced). Load tests poll every 2 s only while one is running.

## ADR-009 Local-first, no hosted deployment (2026-10-25)
**Decision (owner):** Stay local. Free tiers either lose the SQLite file (Render), stop on daily CPU quota (Azure F1), or are time-limited credits (AWS) — see COST-AND-QUOTAS.md. Revisit if remote access becomes necessary.

## ADR-011 Public repository, MIT license (2026-10-25)
**Decision (owner):** Publish `dmonitz` publicly under MIT. Live-test screenshots that show service names stay out of git (`artifacts/screenshots/live/`).

## ADR-010 Windows paths
Project lives in `D:\dmonitz` (the folder Claude Code was launched in) rather than `D:\Projects\dmonitz`, which did not exist; all caches (npm, Electron, electron-builder) are redirected to `D:\dmonitz\.cache`.
