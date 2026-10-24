# Load-test results (measured)

**Date:** 2026-10-25 · **Runner:** SentinelOps built-in (closed-loop virtual users in a Node.js worker thread) · **Host:** the development laptop (Windows 11, Node 24.19) · **Target:** SentinelOps QA instance on `localhost:4610`.

| # | Endpoint | VUs | Duration (ramp) | Requests | Req/s | p50 | p95 | p99 | Max | Errors | Verdict (p95 ≤ 300 ms, errors ≤ 1 %) |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | `/api/health` | 5 | 20 s (5 s) | 1,171 | 233.7 | 3 | 15 | 17 | 171 | 50.1 % (429) | **Aborted** — see below |
| 2 | `/api/health` | 5 | 20 s (5 s) | 28,792 | 1,439.5 | 3 | 5 | 13 | 175 | 0 % | pass |
| 3 | `/api/health` | 25 | 30 s (10 s) | 54,041 | 1,800.9 | 11 | 18 | 33 | 292 | 0 % | pass |
| 4 | `/api/health` | 100 | 30 s (10 s) | 54,022 | 1,798.8 | 47 | 73 | 89 | 161 | 0 % | pass |
| 5 | `/api/health` | 200 | 30 s (10 s) | 29,014 | 963.2 | 144 | 432 | 755 | 1,708 | 0 % | **fail** (p95) |
| 6 | `/` (web UI shell) | 50 | 30 s (10 s) | 41,560 | 1,384.2 | 28 | 54 | 76 | 248 | 0 % | pass |

Latencies in milliseconds.

## Findings

- **Run 1 exposed a real defect**: the load generator and the browser shared `127.0.0.1`, so the per-IP API rate limit (600/min) rejected half the requests and locked the UI out. The auto-abort stop condition worked (stopped at > 50 % errors). Fix: `/api/health` is exempt from rate limiting and the API limit is now keyed per session for signed-in users. Regression test added.
- A second defect: the worker thread never exited after reporting, so the runner refused further tests. Fixed (explicit termination) with a lifecycle test.
- **Throughput saturates at ≈ 1,800 req/s** between 25 and 100 VUs; adding VUs beyond that only adds queueing latency (p95 18 → 73 ms). At 200 VUs throughput fell to 963 req/s and p95 exceeded the 300 ms threshold — the failure boundary on this hardware.

## Limitations — read before quoting these numbers

- The load generator runs **inside the same Node.js process** as the server (worker thread), on the same laptop. The reported "server process CPU" includes the generator. Dedicated hardware would perform better.
- `/api/health` is the cheapest endpoint (one `SELECT 1`). Authenticated, data-heavy endpoints such as `/api/overview` are slower and are rate-limited per session at 600/min by design.
- 100 closed-loop VUs with zero think time generate far more traffic than 100 real users. These results do **not** show that SentinelOps supports N concurrent users; they show the request throughput and latency envelope of one process.
- To estimate concurrent users: measure real per-user request rates (e.g. ~1 request / 5 s with SSE) and divide sustainable throughput by that rate, then validate with a k6 test from a separate machine (`loadtest/k6/overview.js`).
