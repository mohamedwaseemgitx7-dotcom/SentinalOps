# Security plan and threat model

## Assets

Administrator account and sessions · GitHub credentials (env or `gh` CLI) · repository metadata and findings (may describe unfixed vulnerabilities) · CI log excerpts · monitored endpoints · audit log.

## Trust boundaries

1. Browser ↔ server (cookies, CSRF, CSP).
2. Server ↔ GitHub / OSV / monitored sites (outbound only, timeouts, bounded reads).
3. Server ↔ repository content and CI logs (**untrusted input** — may contain prompt-injection text, huge files, secrets, hostile paths).
4. Desktop: Electron main ↔ sandboxed renderer (single IPC call).

## Threats and mitigations

| Threat | Mitigation | Verified by |
|---|---|---|
| Default/weak credentials | No defaults; one-time setup token on the host; 12+ char policy; scrypt | `app.test.ts` setup + password tests |
| Credential stuffing / brute force | 10 attempts/min/IP; per-account lockout with exponential back-off; generic error messages; constant-ish timing for unknown users | rate-limit + lockout tests |
| Session theft / fixation | 256-bit random tokens stored hashed; HttpOnly + SameSite=Strict; sliding 12 h expiry; revoke other sessions on password change; SSE closed on revocation | session revocation test |
| CSRF | Per-session token in `X-CSRF-Token` required on all mutations, plus SameSite=Strict | CSRF test |
| Broken access control | Deny-by-default `onRequest` guard; admin role for mutations; admin-only audit/users | viewer read-only test; unauthenticated sweep test |
| XSS | React escaping; no `dangerouslySetInnerHTML`; CSP `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'` | header smoke test |
| CSV/formula injection in exports | Cells starting with `= + - @` are prefixed with `'` | CSV test |
| Secret exposure in UI/logs/DB | Never persist tokens; redact evidence and log excerpts; logger redacts cookies/auth headers | secret scanner tests |
| Path traversal in local analysis | Resolve under root; skip symlinks; size caps | traversal test |
| SSRF via monitors/scans | Admin-only; http(s) only; no embedded credentials; bounded timeouts/bodies. Admins *can* target internal hosts intentionally (it is their machine). | — (documented risk) |
| Abuse of load testing | Local targets only, or monitored origin + explicit ownership confirmation; hard VU/duration caps; auto-abort on error rate; audited | load-test authorisation test |
| Malicious PR code | Gatekeeper never checks out or runs PR code; reads diffs only | design |
| Prompt injection in repo/log content | No AI provider is called; if one is added, content must be treated as data and sent only after explicit approval | design |
| Supply chain | Exact-version pins ≥ 2 weeks old (security patches excepted); npm install scripts blocked by default; `npm audit` in CI; actions pinned to SHAs; Dependabot | `npm audit`: 0 vulnerabilities (2026-10-25) |
| Desktop compromise via renderer | `contextIsolation`, `sandbox`, no `nodeIntegration`; navigation and new windows blocked except `https://` to the system browser; permission requests denied; server on loopback | smoke launch |
| Account sprawl | Hard ceiling of **3 accounts**; pending invitations reserve seats; enforced in the service layer (setup, invite, accept) | max-users test |
| Webhook SSRF (incl. DNS rebinding, redirects to metadata IPs) | http(s) only; resolve once, block private/loopback/link-local/CGNAT/multicast (IPv4+IPv6, v4-mapped) unless the channel opts in; connection pinned to the validated IP; no redirects; 10 s timeout; response bodies never read back | SSRF tests |
| Webhook URL disclosure | AES-256-GCM encryption with a key file in the data folder (not in the DB); API returns only `scheme://host/…` | secret-storage tests |
| Heartbeat token theft / brute force | 192-bit random tokens stored only as SHA-256; 404 for unknown tokens; 60 pings/min per token+IP; rotation; 10 KB body cap | heartbeat tests |
| Malicious monitor responses | Assertions: no eval, globs not regex (no ReDoS), prototype keys refused, caps on depth/length/count, 1 MB body cap, fail-closed | conditions tests |
| Unsigned binaries tampered in transit | Publish SHA-256 hashes; recommend building from source | RELEASE-CHECKLIST |

## Release gate

Release is blocked on: any open **critical/high** finding in SentinelOps' own repository that is not a documented false positive; `npm audit --audit-level=high` failures; failing auth/authz tests; gitleaks findings.

## Checks that ran (2026-10-25)

- Unit/API/security tests: 52 passed. E2E: 7 passed (desktop + mobile).
- `npm audit`: 0 vulnerabilities after upgrading Electron 44.9.3, Fastify 5.12.7, Zod 4.6.7.
- Self-analysis with SentinelOps: found 3 scanner false positives (fixed with regression tests) and true hygiene gaps (README, SECURITY, CI, Dependabot, LICENSE — all added).
- Windows Defender on-demand scan of installer, portable exe and app exe: no threats. Binaries are **not signed**.
- Not run (not installed): Gitleaks, Trivy, Semgrep locally. Gitleaks runs in CI.

## Backup and recovery

The database is a single SQLite file (`data/sentinelops.db`, WAL mode). Back up by stopping the app and copying the `data` folder, or use `sqlite3 sentinelops.db ".backup backup.db"` while running. To recover, stop the app and replace the folder. Losing the database loses history only; repositories can be re-analysed.
