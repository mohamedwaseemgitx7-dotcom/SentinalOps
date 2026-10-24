# Installation log

## Environment audit (2026-10-24)

| Item | Found |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| Disk | C: 11.4 GB free (constrained) · D: 108.5 GB free |
| Git | 2.55.0 · Node 24.19.0 · npm 11.17.0 · pnpm 10.14.0 · Python 3.14.7 · GitHub CLI 2.97.0 (signed in) · Claude Code 2.1.310 |
| Not installed | Docker, Terraform, k6, Trivy, Gitleaks, Semgrep, Rust |
| Workspace | `D:\dmonitz` empty; `D:\Projects\dmonitz` absent; `D:\Projects\FlashCart-CloudOps` untouched |
| GitHub | repo name `dmonitz` available under `mohamedwaseemgitx7-dotcom` |

## Installed

| What | How | Where | Remove |
|---|---|---|---|
| npm dependencies (exact pins, see package.json files) | `npm ci` | `D:\dmonitz\node_modules` | delete the folder |
| npm cache | `.npmrc cache=` | `D:\dmonitz\.cache\npm` | delete the folder |
| Electron 44.9.3 binary | first run of `electron` (official GitHub release, checksum-verified by the package) | `D:\dmonitz\node_modules\electron\dist` (369 MB) + cache `D:\dmonitz\.cache\electron` | delete those folders |
| electron-builder tools (NSIS 3.0.4.1, 7zip, icons) | downloaded by electron-builder | `D:\dmonitz\.cache\electron-builder` | delete the folder |
| Cloudflare `security-audit` skill | cloned `github.com/cloudflare/security-audit-skill` @ `c1c8a8c` (MIT), inspected (validators use only `fs`/`path`/`util`; no network, no process spawning), copied | `D:\dmonitz\.claude\skills\security-audit` (project-scoped) | delete the folder |

npm 11 blocked install scripts for `esbuild` (postinstall only verifies the platform binary, delivered via optional dependency) and `electron-winstaller` (Squirrel, unused). They were **not approved** and nothing broke.

## Cloudflare security-audit skill notes

Self-tests: 46 passed, 7 failed, 12 skipped. The failures are by design on Windows: the report validators (`validate-findings.cjs`, `validate-coverage-ledger.cjs`) require OS no-follow/non-blocking file flags and refuse to run without them ("OS no-follow and nonblocking input protection is unavailable"). The skill's audit guidance works; only machine validation of its JSON report is unavailable on Windows.

## Requested but not installed

| Item | Reason |
|---|---|
| Higgsfield (skill/MCP) | Paid image/video generation service (subscription required) — conflicts with ₹0 budget and is unrelated to DevOps diagnostic accuracy. |
| NVIDIA Skillspector, Ponytail, Headroom, Graphify, img2threejs, Taste, Impeccable, awesome-design-md, screenshot-to-code | Not verified or installed in this session. None is required by the build; each would need source verification and owner approval before installation. Architecture knowledge is kept in Markdown/Mermaid (ARCHITECTURE.md, DECISIONS.md). |
| Docker, Terraform, k6, Trivy, Gitleaks, Semgrep (local) | Not installed to avoid system-wide changes on a constrained C: drive. Docker image build and Gitleaks run in CI; a k6 script is provided in `loadtest/k6`. |

## Playwright

Uses the locally installed Google Chrome (`channel: 'chrome'`) — no browser download. CI installs Chromium in the runner.
