// k6 scenario for an authenticated SentinelOps session.
// Run only against an instance you own, ideally from a different machine:
//   k6 run -e BASE_URL=http://host:4600 -e SO_USER=... -e SO_PASSWORD=... --summary-export=summary.json loadtest/k6/overview.js
// Then import summary.json in SentinelOps → Load tests → Import k6 results.
// Note: the server limits each session to 600 API requests/min; each VU logs in with its own session.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:4600';

export function setup() {
  if (!__ENV.SO_USER || !__ENV.SO_PASSWORD) throw new Error('Set SO_USER and SO_PASSWORD (a test account, not your admin).');
}

export default function () {
  // Log in once per VU iteration group; k6 keeps the cookie jar per VU.
  if (__ITER === 0) {
    const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ username: __ENV.SO_USER, password: __ENV.SO_PASSWORD }), { headers: { 'Content-Type': 'application/json' } });
    check(res, { 'logged in': (r) => r.status === 200 });
  }
  const overview = http.get(`${BASE}/api/overview`);
  check(overview, { 'overview 200': (r) => r.status === 200 });
  http.get(`${BASE}/api/incidents?status=active&limit=1`);
  // Real users read the page between actions.
  sleep(5);
}
