# Release checklist — v0.2.0

| Gate | Status | Evidence |
|---|---|---|
| Typecheck (server + web) | ✅ | `npm run typecheck` |
| Unit/API/security tests | ✅ 88 passed | `npm test` |
| E2E desktop + mobile | ✅ 7 passed (3 skipped by design) | `npx playwright test` |
| `npm audit --audit-level=high` | ✅ 0 vulnerabilities | 2026-10-25 |
| Secret scan of this repository | ✅ no secrets (self-analysis; gitleaks in CI) | SentinelOps self-analysis |
| Own critical/high findings | ✅ none open after false-positive fixes | self-analysis |
| Access control tests | ✅ | `app.test.ts` |
| Desktop exe launches | ✅ dev, packaged, portable, and installed copy (`D:\SentinelOps`) | `artifacts/screenshots/desktop-*.png` |
| Defender scan of binaries | ✅ no threats | MpCmdRun |
| Code signing | ❌ not signed — Artifact Signing unavailable to individuals in India; OV certificate is paid; ₹0 route is the Microsoft Store (MSIX, signed by Microsoft) | BUILD_WINDOWS.md |
| Windows block investigation | ✅ no Defender/SmartScreen/SAC/CFA/Code Integrity block on this PC; SmartScreen will warn on downloaded copies | BUILD_WINDOWS.md |
| Store package builds | ✅ AppX manifest verified (placeholder identity, test package deleted) | BUILD_WINDOWS.md |
| LICENSE | ✅ MIT | `LICENSE` |
| Cloud deployment | ⛔ owner chose local-first | DECISIONS.md ADR-009 |
| CI on GitHub | ✅ all 4 jobs green (run 40125080435) | build/test, e2e, gitleaks (full history), container build + smoke |
| Branch protection | ✅ `main` requires the 4 CI checks; no force-push/deletion | GitHub settings |

## Artifacts (rebuilt 2026-10-25 06:12 from the latest code, unsigned, Defender: no threats)

| File | Size | SHA-256 |
|---|---:|---|
| `SentinelOps-0.2.0-x64-setup.exe` | 121,189,057 B | `DFC568338039CB3FAB89D250F1C3957528EE3CB04673E54388FE66CAD2C81A1A` |
| `SentinelOps-0.2.0-portable.exe` | 120,944,994 B | `243275A9A538A0F999B94FB150F9203A61D94CD019FD48FF0B1C44E7A264D388` |

Verify: `Get-FileHash .\SentinelOps-0.1.0-x64-setup.exe -Algorithm SHA256`.

## Install / uninstall (Windows)

- Install: run the setup exe → choose folder (per-user, no admin) → shortcuts are created.
- Portable: run the portable exe from any folder.
- Uninstall: *Settings → Apps → SentinelOps → Uninstall*. Data in `%APPDATA%\SentinelOps\data` is kept; delete it manually to remove all history.
