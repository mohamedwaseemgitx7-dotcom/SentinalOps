# SentinelOps — notes for Claude Code

Read `docs/PROJECT-STATUS.md` first in every new session, then this file.

## Layout

- `apps/server` — Fastify API + SQLite (`node:sqlite`). Entry `src/index.ts`; `src/app.ts` builds the app (used by tests and the desktop shell via `src/embedded.ts`).
  - `auth/` sessions, setup token, invites · `analysis/` repo analysis, rules, OSV, CI log diagnosis, PR gatekeeper · `monitoring/` probes, site scans, scheduler · `loadtest/` worker-thread runner · `health.ts` score · `routes/` HTTP.
- `apps/web` — React 19 + Vite. `src/lib` (api with CSRF, router, SSE live data), `src/components` (ui, charts, shell), `src/pages`.
- `apps/desktop` — Electron shell; `scripts/bundle.mjs` bundles the server with esbuild; electron-builder config in `package.json`.
- `e2e/` Playwright · `fixtures/ci-logs` real/synthetic CI logs for diagnosis tests · `docs/` · `artifacts/screenshots` evidence.

## Commands

- `npm run dev` · `npm run build` · `npm start` · `npm run typecheck` · `npm test` · `npx playwright test` · `npm run desktop:build`
- Server runs TypeScript directly with Node 24 type stripping: **no enums, no constructor parameter properties** (`erasableSyntaxOnly`). Relative imports use `.ts` extensions.
- Keep npm/electron caches on D: — `.npmrc` sets `cache=D:\dmonitz\.cache\npm`; export `electron_config_cache`/`ELECTRON_BUILDER_CACHE` to `D:\dmonitz\.cache\...` before desktop builds (C: has little free space).

## Rules that matter here

- Never fabricate metrics. Unknown data must render as unknown. The health score is withheld below 50 % coverage.
- Never store or log secrets. Tokens come from `GITHUB_TOKEN` or `gh auth token` on demand. Findings store redacted evidence and a hash-based fingerprint only.
- Every new API route is authenticated by default (global `onRequest` guard). Mark routes `config: { public: true }` only deliberately; mutations need CSRF and the admin role unless `anyRole`.
- Dependencies: pin exact versions at least two weeks old, except security patches. `npm install` scripts are blocked by npm's allow-scripts; review before approving.
- Use the throwaway QA data directory for manual testing — never the user's real `data/` folder or account.
- The project-scoped Cloudflare `security-audit` skill is installed in `.claude/skills/security-audit` (validators cannot run on Windows; see docs/INSTALLATION-LOG.md).
