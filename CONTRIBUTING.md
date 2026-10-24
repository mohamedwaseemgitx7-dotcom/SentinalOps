# Contributing

1. Create a branch from `main`.
2. `npm ci`, then make your change with tests.
3. Run `npm run typecheck`, `npm test`, and `npx playwright test` for UI changes.
4. Open a pull request using the template. CI must pass (typecheck, tests, build, `npm audit --audit-level=high`, e2e, gitleaks, container build).

Conventions:

- TypeScript strict mode. Server code must be *erasable* TypeScript (no enums or constructor parameter properties) because Node runs it directly.
- Validate request input with `zod`; every new API route is authenticated by default.
- Never commit `.env` files, tokens, private keys, databases or Terraform state.
- Pin new dependencies to an exact version at least two weeks old (security patches excepted) and explain why the dependency is needed.
- Metrics must come from real measurements; render missing data as unknown.
- Commit messages: imperative mood, short subject, body explaining *why*.
