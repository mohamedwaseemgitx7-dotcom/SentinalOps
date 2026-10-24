# Cost and quotas

Budget: **₹0**. Current state: SentinelOps runs locally (web server or Windows desktop app). **No cloud resources have been created.**

## External services used at runtime (all free)

| Service | Used for | Cost | Quota / limit | What leaves the machine |
|---|---|---|---|---|
| GitHub REST API | repo metadata, trees, file contents, Actions runs/logs, PRs | free | 5,000 req/h with a token; 60 req/h anonymous | requests made with your token |
| OSV.dev API | dependency advisories | free, no key | fair use | package names + versions only (opt-out per analysis) |
| Monitored URLs | health checks | free | your own services; ≥ 60 s interval | HTTP requests to those URLs |

## Hosting options evaluated (2026-10-25)

| Option | Fit | Why |
|---|---|---|
| **Local / desktop app** | ✅ chosen | Full functionality, persistent SQLite, scheduler runs while the app is open, ₹0. Not reachable from other devices. |
| Render Free web service | ⚠️ not recommended | Spins down after 15 min idle (≈ 1 min cold start); **no persistent disk — local files incl. SQLite are wiped on redeploy, restart or spin-down**; 750 instance-hours/month. Monitoring stops while asleep. Source: [render.com/docs/free](https://render.com/docs/free). |
| Azure App Service F1 | ⚠️ possible with limits | Persistent 1 GB storage, Node supported, but ~60 CPU-minutes/day and other quotas; exceeding them stops the app until reset (HTTP 403). No SLA. Needs an Azure account (card verification). Source: [Microsoft Learn — App Service quotas](https://learn.microsoft.com/azure/app-service/web-sites-monitor). |
| AWS (new accounts) | ⚠️ time-limited | Accounts since 15 July 2025 get a credit-based Free plan (up to US$200, ends after 6 months or when spent); EC2 draws down credits. Not "free forever". |
| Cloudflare Workers/Pages | ❌ for the server | The Fastify + `node:sqlite` + worker-thread design does not run on Workers without a rewrite (D1, Durable Objects, Cron Triggers). Pages could host the static UI only. |
| Vercel | ❌ for the server | Serverless functions are not suited to a long-running scheduler with a local SQLite file. |
| Supabase | excluded | Owner requirement. |

## Recommendation

Stay local-first. If remote access is needed, the lowest-risk ₹0 path is **Azure App Service F1** with `SENTINELOPS_SECURE_COOKIES=true`, monitors limited to a few at ≥ 5-minute intervals, and the understanding that the app stops when daily CPU quota is exhausted. This requires the owner's Azure account and explicit approval before any resource is created. Charge triggers to avoid: scaling above F1, adding custom domains with SSL bindings, enabling Application Insights beyond the free allowance.
