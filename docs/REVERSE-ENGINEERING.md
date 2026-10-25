# Repository analysis workflow (reverse engineering)

SentinelOps' analyser implements the workflow below; the same steps apply when doing it by hand.

1. **Verify identity and permission** — `GET /repos/{owner}/{repo}` with the configured token; local folders must exist and are read without following symlinks.
2. **License** — GitHub license detection / LICENSE file presence. Preserve existing notices; never copy code from repositories you analyse.
3. **Map the architecture** — manifests → components; workflows → CI; Dockerfiles/Compose → packaging; Terraform/Kubernetes → infrastructure; config files → deploy targets (`detect.ts`).
4. **Dependencies** — exact versions from lockfiles; OSV.dev advisories; Dependabot alerts if accessible.
5. **Trace build and deployment** — GitHub Actions runs, jobs and steps; deployment-like workflows; GitHub Deployments API.
6. **Run tests in isolation** — SentinelOps does not execute repository code. Run tests yourself in a disposable environment (container or clean clone) without production credentials.
7. **Reproduce failures safely** — use the cited log lines and the same runtime versions; never against production.
8. **Root cause from evidence** — first meaningful error, cascading lines ignored, location extracted where possible.
9. **Propose a minimal fix** — the recommendation on each diagnosis/finding.
10. **Apply only to an authorised branch** — never push to the default branch or someone else's repository.
11. **Regression test** — CI on the branch.
12. **Before/after evidence** — the diagnosis is marked *verified* only after a later run of the same workflow on the same branch succeeds; findings are *resolved* only when the producing check runs again and no longer reports them.

## Example: `mohamedwaseemgitx7-dotcom/chatbot` (2026-10-25)

- 313 files, Python 71.9 % / JavaScript 20.6 %; React, Vite, Tailwind, FastAPI, NumPy; 1 workflow ("Keep backend awake").
- 99 completed runs in 30 days, 93.9 % success. 6 failures diagnosed: the scheduled ping received **HTTP 502** from `farmerassist-api.onrender.com/api/health/ready` four times (curl with 3 retries) → upstream service failure, not repository code. Recovery verified by run #98.
- Findings: `pillow==12.3.0` pinned in `ai/requirements-train.txt` (5 critical, ~20 high OSV advisories); `vite` 5.4.21 / 6.4.3 Windows path advisories. No secrets detected in the 150 scanned files (of 245 candidates).
- Live checks: `/api/health/ready` returned **503** while the API root returned 200 with strong security headers — readiness of a dependency, not host availability.

## Learning from open-source DevOps tools (2026-10-25, v0.2.0)

Three read-only analyses ran in parallel (one agent per tool, following the `dispatching-parallel-agents` skill). Each shallow-cloned the project into a scratch folder, **read** the source without installing or running it, and reported cited design notes. No code was copied; licences were respected.

| Tool | Licence | What we learned (files read) | Adopted in SentinelOps |
|---|---|---|---|
| Uptime Kuma | MIT | Per-monitor timers and PENDING→DOWN retry state machine, keyword/JSON-query checks (`server/model/monitor.js`), notification-provider registry with **plaintext** configs and **no SSRF guard** (`server/notification-providers/`), push monitors (`server/routers/api-router.js`), maintenance windows, status pages | Webhook notifications — but **encrypted** and **SSRF-guarded**; push monitors |
| Gatus | Apache-2.0 | Condition strings `[STATUS] == 200`, `[BODY].path`, durations (`config/endpoint/condition.go`, `placeholder.go`), hand-written JSON path walker (`jsonpath/jsonpath.go`), failure/success thresholds (`watchdog/alerting.go`). Pitfalls: unparseable numbers become **0** (a broken condition can silently pass); bodies read with unbounded `io.ReadAll` | Response assertions that **fail closed**, 1 MB body cap, prototype keys refused, globs not regex; success-threshold hysteresis |
| Healthchecks | BSD-3 | Check model (timeout, grace, new/up/down/paused, `/start`, `/fail`, exit codes) in `hc/api/models.py`, `sendalerts` conditional-update loop, connect-time private-IP check for webhooks (`hc/lib/curl.py`). Pitfalls: no app-level ping rate limit; codes stored in plain text | Heartbeats with **hashed tokens**, per-token+IP **rate limiting**, conditional `UPDATE … WHERE status='up'` so an incident opens exactly once |

**Not adopted yet:** public status pages and maintenance windows (most useful for public teams; SentinelOps is a ≤ 3-user personal tool), user templates for webhook bodies (injection surface), TCP/DNS monitor types, hourly uptime rollups.

The `reverse-engineer-anything` skill targets shipped binaries through an external REA engine and itself says to skip REA for ordinary source repositories — all three tools are open source, so normal source reading was the right method and the REA engine was not installed.
