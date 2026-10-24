# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting:
<https://github.com/mohamedwaseemgitx7-dotcom/dmonitz/security/advisories/new>

Include affected version, steps to reproduce, and impact. You will get an acknowledgement within 7 days. Please allow 90 days for a fix before public disclosure.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Security model (summary)

- No default credentials. The first administrator is created with a one-time token readable only on the host.
- Passwords: scrypt (N=2^15, r=8, p=1), 12+ characters, account lockout with exponential back-off, per-IP login rate limit.
- Sessions: random 256-bit tokens stored hashed; HttpOnly, SameSite=Strict cookies (`Secure` when `SENTINELOPS_SECURE_COOKIES=true`); CSRF token required on every mutation; sessions revoked on password change.
- Authorisation: deny-by-default guard on every `/api/*` route; viewers are read-only; admin-only endpoints for users and audit log.
- Secrets: never persisted; scanner evidence is redacted; CI log excerpts are redacted before storage.
- Headers: strict CSP (`script-src 'self'`), `frame-ancestors 'none'`, nosniff, HSTS behind HTTPS.
- Desktop: server bound to 127.0.0.1 on a random port; sandboxed renderer without Node; navigation locked to the app origin.

Details and the threat model: [docs/SECURITY-PLAN.md](docs/SECURITY-PLAN.md).
