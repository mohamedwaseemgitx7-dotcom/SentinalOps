# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm start` fails with "Cannot find module …\dist\index.js" (fixed) | Older start script needed a separate build | `npm start` now builds first; or double-click `Start-SentinelOps.cmd`. |
| Setup screen asks for a token | First run; no admin exists | Copy the token printed in the server console or from `data/setup-token.txt` (desktop: click **Fill**). |
| Lost the setup token | Server restarted before setup | Restart: a new token is generated while no user exists. |
| "Too many failed attempts" | Account lockout after 5 failures | Wait (1–60 min, exponential). Locks reset after a successful login. |
| Forgot admin password | No email recovery (₹0, local-first) | On the host: stop the server, run `npm run reset-accounts -w @sentinelops/server -- --yes` (desktop: set `SENTINELOPS_DATA_DIR=%APPDATA%\SentinelOps\data` first). Accounts and sessions are removed, all data is kept, and the next start prints a new setup token. Requires filesystem access to the host — the same trust level as first-run setup. |
| "GitHub API rate limit reached" | Anonymous access (60/h) | Set `GITHUB_TOKEN` or enable *Settings → Use my local GitHub CLI login*. |
| Dependabot alerts "Unavailable (HTTP 403)" | Token lacks security-alert access or alerts disabled | Expected for many tokens; OSV advisories still run. |
| Workflow logs unavailable | Logs expired (90 days) or missing `actions:read` | Re-run on GitHub or use a token with Actions read. |
| "Rate limit exceeded" in the UI | > 600 API requests/min in this session | Wait a minute. Load tests against `/api/health` no longer affect the UI. |
| Load test: "already running" | One test at a time | Wait for it or press **Stop test**. |
| Remote load test refused | Target is not a configured monitor or ownership not confirmed | Add it as a monitor first; tick the ownership confirmation; caps are 25 VUs / 60 s. |
| Monitor shows 503 but the site works in a browser | Health endpoint reports a dependency (e.g. DB) not ready, or a free-tier host is waking up | Check the service's own logs; SentinelOps reports what it observed, not the internal cause. |
| Desktop app shows "could not start its local server" | Data folder not writable or database locked by another instance | Close other instances; check `%APPDATA%\SentinelOps\data`. |
| SmartScreen "Windows protected your PC" on the .exe | Downloaded copy (Mark of the Web) of an unsigned binary | Verify the SHA-256 in RELEASE-CHECKLIST.md, then *More info → Run anyway*. Do not disable SmartScreen. Long-term fix: Microsoft Store or a CA certificate — see BUILD_WINDOWS.md. |
| Desktop data seems missing after upgrading from 0.1.0 | 0.1.0 stored data in `%APPDATA%\@sentinelops\desktop\data` | 0.2.0 copies it to `%APPDATA%\SentinelOps\data` automatically on first start (original kept). |
| `npm ci` very slow / C: filling up | npm cache on C: | `.npmrc` already points the cache to `D:\dmonitz\.cache\npm`; keep it. |
| Electron build downloads to C: | Cache env not set | Export `electron_config_cache` and `ELECTRON_BUILDER_CACHE` to `D:\dmonitz\.cache\...` first. |
| Server crashes on start with "erasableSyntaxOnly" style errors | Non-erasable TypeScript (enum / parameter properties) | Rewrite as plain fields; Node 24 runs `.ts` by stripping types only. |
| Root URL returned 403 (fixed) | Static plugin treated `/` as a directory | Explicit `/` route serves the app shell. |
