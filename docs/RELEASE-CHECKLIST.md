# Release checklist — v0.1.0

| Gate | Status | Evidence |
|---|---|---|
| Typecheck (server + web) | ✅ | `npm run typecheck` |
| Unit/API/security tests | ✅ 52 passed | `npm test` |
| E2E desktop + mobile | ✅ 7 passed (3 skipped by design) | `npx playwright test` |
| `npm audit --audit-level=high` | ✅ 0 vulnerabilities | 2026-10-25 |
| Secret scan of this repository | ✅ no secrets (self-analysis; gitleaks in CI) | SentinelOps self-analysis |
| Own critical/high findings | ✅ none open after false-positive fixes | self-analysis |
| Access control tests | ✅ | `app.test.ts` |
| Desktop exe launches | ✅ dev, packaged, portable | `artifacts/screenshots/desktop-*.png` |
| Defender scan of binaries | ✅ no threats | MpCmdRun |
| Code signing | ❌ not signed (no certificate; ₹0) | documented |
| LICENSE | ✅ MIT | `LICENSE` |
| Cloud deployment | ⛔ owner chose local-first | DECISIONS.md ADR-009 |
| CI on GitHub | ⏳ runs after the repository is published | `.github/workflows/ci.yml` |

## Artifacts (built 2026-10-25, unsigned)

| File | Size | SHA-256 |
|---|---:|---|
| `SentinelOps-0.1.0-x64-setup.exe` | 121,177,819 B | `06638C6C2389809D6BEF687B6266FE6BAD09B85E98477DA0F0B13CF6CF0A971B` |
| `SentinelOps-0.1.0-portable.exe` | 120,933,936 B | `B9767C2F086A031B3ECC8BCC0527F2E8BD1AF3C9C857F60439B2DE1639E5C5E1` |
| `win-unpacked/SentinelOps.exe` | — | `63E81FDF48276685550D89FD244D37CD01B8D64F3B44DBD1749F161B91B9D740` |

Verify: `Get-FileHash .\SentinelOps-0.1.0-x64-setup.exe -Algorithm SHA256`.

## Install / uninstall (Windows)

- Install: run the setup exe → choose folder (per-user, no admin) → shortcuts are created.
- Portable: run the portable exe from any folder.
- Uninstall: *Settings → Apps → SentinelOps → Uninstall*. Data in `%APPDATA%\SentinelOps\data` is kept; delete it manually to remove all history.
