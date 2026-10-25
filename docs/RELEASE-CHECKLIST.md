# Release checklist — v0.1.0

| Gate | Status | Evidence |
|---|---|---|
| Typecheck (server + web) | ✅ | `npm run typecheck` |
| Unit/API/security tests | ✅ 53 passed | `npm test` |
| E2E desktop + mobile | ✅ 7 passed (3 skipped by design) | `npx playwright test` |
| `npm audit --audit-level=high` | ✅ 0 vulnerabilities | 2026-10-25 |
| Secret scan of this repository | ✅ no secrets (self-analysis; gitleaks in CI) | SentinelOps self-analysis |
| Own critical/high findings | ✅ none open after false-positive fixes | self-analysis |
| Access control tests | ✅ | `app.test.ts` |
| Desktop exe launches | ✅ dev, packaged, portable, and installed copy (`D:\SentinelOps`) | `artifacts/screenshots/desktop-*.png` |
| Defender scan of binaries | ✅ no threats | MpCmdRun |
| Code signing | ❌ not signed (no certificate; ₹0) | documented |
| LICENSE | ✅ MIT | `LICENSE` |
| Cloud deployment | ⛔ owner chose local-first | DECISIONS.md ADR-009 |
| CI on GitHub | ✅ all 4 jobs green (run 40125080435) | build/test, e2e, gitleaks (full history), container build + smoke |
| Branch protection | ✅ `main` requires the 4 CI checks; no force-push/deletion | GitHub settings |

## Artifacts (rebuilt 2026-10-25 06:12 from the latest code, unsigned, Defender: no threats)

| File | Size | SHA-256 |
|---|---:|---|
| `SentinelOps-0.1.0-x64-setup.exe` | 121,178,183 B | `7647741B7DF26F576FD7CD8D5D295828554C0B76199D9E8C6694AD946DE99A15` |
| `SentinelOps-0.1.0-portable.exe` | 120,934,234 B | `6FB9C00F95D5A525265F4F9E062CFDE0E9B4B08CF3B9B06FA4BEE74468EE2EF1` |

Verify: `Get-FileHash .\SentinelOps-0.1.0-x64-setup.exe -Algorithm SHA256`.

## Install / uninstall (Windows)

- Install: run the setup exe → choose folder (per-user, no admin) → shortcuts are created.
- Portable: run the portable exe from any folder.
- Uninstall: *Settings → Apps → SentinelOps → Uninstall*. Data in `%APPDATA%\SentinelOps\data` is kept; delete it manually to remove all history.
