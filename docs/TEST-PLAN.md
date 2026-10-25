# Test plan

| Layer | Tool | Where | Covers |
|---|---|---|---|
| Unit | Vitest | `apps/server/src/**/*.test.ts` | CI log diagnosis (9 fixtures incl. a real GitHub log), secret scanner precision, workflow/Docker/Terraform rules, dependency extraction, local repo analysis, path traversal |
| API / integration | Vitest + `fastify.inject` | `apps/server/src/app.test.ts` | setup token, password policy & hashing, login, lockout, login rate limit, per-session API rate limit, CSRF, viewer read-only, invites, session revocation, audit log, SPA serving, monitor → incident → recovery, manual-resolve verification, health score coverage, load-test authorisation & lifecycle, CSV injection |
| Browser E2E | Playwright | `e2e/app.spec.ts` | first-run setup, empty states, every section renders without JS errors and without horizontal overflow (desktop 1440×900 and Pixel 7), real monitor check, sign-out |
| Live verification | Chrome + QA instance | manual, screenshots in `artifacts/screenshots` | real GitHub repo analysis, real workflow diagnosis, real monitors, site scan, load tests |
| Desktop | Electron smoke hook | `SENTINELOPS_SMOKE_SCREENSHOT=<png>` | unpackaged, packaged and portable exe launch and render |
| Load | built-in runner, k6 script | `docs/LOAD-TEST-RESULTS.md`, `loadtest/k6` | throughput/latency envelope and failure boundary |
| Supply chain | npm audit, gitleaks (CI), Defender | CI + local | dependency advisories, secrets in history, binary scan |

## Simulated failures and outcomes

| Fixture / scenario | Expected diagnosis | Result |
|---|---|---|
| `npm ci` lockfile out of sync | dependency-install | ✅ |
| TypeScript errors | type-error with file:line | ✅ |
| Jest failure | test-failure with test file | ✅ |
| Docker COPY missing file | docker-build | ✅ |
| Missing `DATABASE_URL` | missing-env | ✅ |
| Heap out of memory | out-of-memory | ✅ |
| `Resource not accessible by integration` | auth-permission | ✅ |
| Python `ModuleNotFoundError` | dependency-install with module name | ✅ |
| Monitor deleted while its check is in flight; id reused | stale result discarded | ❌ found by CI (stale write into new monitor) → fixed → ✅ |
| **Real** keep-alive job: `curl … returned error: 502` | network (upstream 5xx, not repo code) | ❌ first classified as build-error → rule added → ✅ |
| Unknown failure | low confidence, no guess | ✅ |
| Monitored service returns 503 | incident after threshold; manual resolve refused; auto-resolve on recovery | ✅ |

## Results (2026-10-25)

- `npm test`: **88 passed** (v0.2.0).
- `npx playwright test`: **7 passed**, 3 skipped by design (desktop-only steps).
- Desktop: dev, packaged and portable builds launched and rendered (screenshots in `artifacts/screenshots`).

## Running

```powershell
npm test
npx playwright test
npx playwright show-report   # after a run
```
