# System Health Pulse — definition

Implemented in `apps/server/src/health.ts`. This document and the code must change together.

## Inputs

| Component | Weight | Score (0–100) | Unknown when |
|---|---:|---|---|
| CI success rate | 25 | `successful ÷ (successful + failed)` over completed workflow runs in the last 30 days. Failed = `failure`, `timed_out`, `startup_failure`. Cancelled/skipped are excluded. | fewer than 3 such runs |
| Security findings | 25 | `100 − (25·critical + 10·high + 3·medium + 1·low)` over **open** findings (info excluded, suppressed excluded), floored at 0 | no repository has a completed analysis |
| Open incidents | 20 | `100 − (40·critical + 25·high + 10·medium + 5·low)` over unresolved incidents, floored at 0 | no repository and no monitor is connected |
| Availability (24h) | 20 | Let `u` = successful ÷ total health checks in the last 24 h (in %). Score = `(u − 90) / 10 · 100`, clamped to 0–100 (90 % → 0, 99 % → 90, 100 % → 100) | no checks in 24 h |
| Response time (24h) | 10 | share of successful checks whose latency ≤ that monitor's threshold (default 1000 ms) | no successful checks in 24 h |

Per-repository scores (repository detail page) use only CI, security and incidents for that repository; monitors are not tied to repositories.

## Aggregation

1. Components with no data are **excluded**, never assumed healthy.
2. `coverage = Σ weights with data ÷ Σ all weights`.
3. If `coverage < 0.5`, **no score is produced** — the UI shows "Insufficient data" and the coverage. (Otherwise a single input, e.g. "0 open incidents", would dominate the headline.)
4. Otherwise `score = round(Σ score_i·weight_i ÷ Σ weight_i)` over components with data.
5. Status: `≥ 85` healthy · `≥ 65` warning · otherwise critical. When `coverage < 1` the UI shows a *Partial* badge with the coverage percentage.

## Snapshots

A snapshot (`health_snapshots`) is stored at most every 15 minutes while the server runs, only when a score exists. Trends therefore have gaps when the app is not running — they are not back-filled.

## What the score is not

It is an operational summary of the connected data sources, not a verified, system-wide measure of reliability or security. Each component shows its raw value and basis in the UI.

## Worked example (measured, 2026-10-25, QA instance)

`chatbot` repository + 2 monitors: CI 93.9 % of 99 runs → 94; security 5 critical / 27 high → 0; incidents 1 critical → 60; availability 91.67 % → 17; latency 81.8 % → 82; coverage 100 %. Score = (94·25 + 0·25 + 60·20 + 17·20 + 82·10) / 100 = 47 → **critical**.
