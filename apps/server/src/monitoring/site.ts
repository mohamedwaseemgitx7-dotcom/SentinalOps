import dns from 'node:dns/promises';
import { probe, tlsInfo, validateTargetUrl, type TlsInfo } from './probe.ts';

export type CheckLevel = 'pass' | 'warn' | 'fail' | 'info';

export interface SiteCheck {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

export interface SiteReport {
  url: string;
  finalUrl: string;
  scannedAt: string;
  reachable: boolean;
  statusCode: number | null;
  error: string | null;
  timing: { dnsMs: number | null; ttfbMs: number | null; totalMs: number | null; bodyBytes: number };
  redirects: { status: number; location: string }[];
  dns: { a: string[]; aaaa: string[]; error: string | null };
  tls: TlsInfo | null;
  tlsError: string | null;
  headers: SiteCheck[];
  cookies: SiteCheck[];
  technology: { name: string; evidence: string }[];
  extras: SiteCheck[];
  unavailable: string[];
}

const SECURITY_HEADERS: { header: string; label: string; check: (v: string | undefined, https: boolean) => [CheckLevel, string] }[] = [
  { header: 'strict-transport-security', label: 'HSTS', check: (v, https) => (!https ? ['info', 'Not applicable over HTTP'] : !v ? ['fail', 'Missing — browsers may be downgraded to HTTP'] : /max-age=(\d+)/.exec(v) && Number(/max-age=(\d+)/.exec(v)![1]) >= 15552000 ? ['pass', v] : ['warn', `max-age below 180 days: ${v}`]) },
  { header: 'content-security-policy', label: 'Content-Security-Policy', check: (v) => (!v ? ['warn', 'Missing — no defence-in-depth against XSS'] : /unsafe-inline|unsafe-eval|\*/.test(v) && !/nonce-|strict-dynamic/.test(v) ? ['warn', 'Present but allows unsafe-inline/unsafe-eval or wildcards'] : ['pass', v.slice(0, 160)]) },
  { header: 'x-content-type-options', label: 'X-Content-Type-Options', check: (v) => (v?.toLowerCase() === 'nosniff' ? ['pass', v] : ['warn', 'Missing nosniff']) },
  { header: 'x-frame-options', label: 'Clickjacking protection', check: (v) => (v ? ['pass', `X-Frame-Options: ${v}`] : ['warn', 'No X-Frame-Options (check CSP frame-ancestors)']) },
  { header: 'referrer-policy', label: 'Referrer-Policy', check: (v) => (v ? ['pass', v] : ['info', 'Missing (browser default strict-origin-when-cross-origin applies)']) },
  { header: 'permissions-policy', label: 'Permissions-Policy', check: (v) => (v ? ['pass', v.slice(0, 160)] : ['info', 'Missing']) },
  { header: 'server', label: 'Server banner', check: (v) => (v && /\d/.test(v) ? ['warn', `Discloses version: ${v}`] : v ? ['info', v] : ['pass', 'Not disclosed']) },
  { header: 'x-powered-by', label: 'X-Powered-By', check: (v) => (v ? ['warn', `Discloses framework: ${v}`] : ['pass', 'Not disclosed']) },
];

const TECH_HEADERS: [string, RegExp | null, string][] = [
  ['cf-ray', null, 'Cloudflare'], ['x-vercel-id', null, 'Vercel'], ['x-nf-request-id', null, 'Netlify'], ['x-amz-cf-id', null, 'Amazon CloudFront'],
  ['x-github-request-id', null, 'GitHub Pages'], ['x-render-origin-server', null, 'Render'], ['fly-request-id', null, 'Fly.io'], ['x-azure-ref', null, 'Azure Front Door'],
  ['server', /nginx/i, 'nginx'], ['server', /apache/i, 'Apache httpd'], ['server', /cloudflare/i, 'Cloudflare'], ['server', /gws/i, 'Google Web Server'],
  ['x-powered-by', /express/i, 'Express'], ['x-powered-by', /next\.js/i, 'Next.js'], ['x-powered-by', /php/i, 'PHP'], ['x-powered-by', /asp\.net/i, 'ASP.NET'],
];

const TECH_BODY: [RegExp, string][] = [
  [/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i, '$1'], [/\/_next\/static\//, 'Next.js'], [/__NUXT__|\/_nuxt\//, 'Nuxt'],
  [/data-reactroot|react-dom/, 'React'], [/ng-version=/, 'Angular'], [/wp-content\//, 'WordPress'], [/\/@vite\/client|type="module" crossorigin src="\/assets\/index-/, 'Vite'],
  [/data-svelte|__sveltekit/, 'SvelteKit'], [/cdn\.shopify\.com/, 'Shopify'], [/gtag\(|googletagmanager\.com/, 'Google Tag Manager / Analytics'],
];

/**
 * Inspects only what any visitor can observe: DNS, TLS, headers, redirects, timing and
 * public markup. It cannot see source code, CI/CD, infrastructure or real user capacity.
 */
export async function analyzeSite(input: string): Promise<SiteReport> {
  const url = validateTargetUrl(input);
  const https = url.protocol === 'https:';
  const [res, dnsResult, tlsResult] = await Promise.all([
    probe(url.toString(), { timeoutMs: 15_000, keepBody: true, maxBody: 1024 * 1024 }),
    Promise.allSettled([dns.resolve4(url.hostname), dns.resolve6(url.hostname)]),
    https ? tlsInfo(url.hostname, Number(url.port) || 443).then((t) => ({ t, e: null }), (e: Error) => ({ t: null, e: e.message })) : Promise.resolve({ t: null, e: null }),
  ]);
  const a = dnsResult[0].status === 'fulfilled' ? dnsResult[0].value : [];
  const aaaa = dnsResult[1].status === 'fulfilled' ? dnsResult[1].value : [];
  const dnsErr = dnsResult[0].status === 'rejected' && dnsResult[1].status === 'rejected' ? String((dnsResult[0].reason as Error).message) : null;

  const finalHttps = res.finalUrl.startsWith('https:');
  const headers = SECURITY_HEADERS.map(({ header, label, check }) => {
    const [level, detail] = check(res.headers[header], finalHttps);
    return { id: header, label, level, detail };
  });

  const cookies: SiteCheck[] = res.setCookies.map((c) => {
    const name = c.split('=')[0]!.trim();
    const lower = c.toLowerCase();
    const missing = [!lower.includes('secure') && finalHttps ? 'Secure' : null, !lower.includes('httponly') ? 'HttpOnly' : null, !lower.includes('samesite') ? 'SameSite' : null].filter(Boolean);
    return { id: `cookie:${name}`, label: `Cookie ${name}`, level: missing.length ? 'warn' : 'pass', detail: missing.length ? `Missing ${missing.join(', ')} (may be intentional for non-session cookies)` : 'Secure, HttpOnly, SameSite set' } as SiteCheck;
  });

  const technology: { name: string; evidence: string }[] = [];
  for (const [h, re, name] of TECH_HEADERS) {
    const v = res.headers[h];
    if (v !== undefined && (!re || re.test(v)) && !technology.some((t) => t.name === name)) technology.push({ name, evidence: `header ${h}${re ? `: ${v.slice(0, 60)}` : ''}` });
  }
  if (res.body) {
    for (const [re, name] of TECH_BODY) {
      const m = res.body.match(re);
      if (m) {
        const label = name.startsWith('$') ? m[1]!.slice(0, 60) : name;
        if (!technology.some((t) => t.name === label)) technology.push({ name: label, evidence: 'page markup' });
      }
    }
  }

  const extras: SiteCheck[] = [];
  if (https && res.redirects.some((r) => r.location.startsWith('http:'))) extras.push({ id: 'downgrade', label: 'Redirect downgrade', level: 'fail', detail: 'A redirect points to plain HTTP' });
  if (!https) {
    const httpsVersion = await probe(url.toString().replace(/^http:/, 'https:'), { timeoutMs: 8000 });
    extras.push({ id: 'https-available', label: 'HTTPS', level: httpsVersion.statusCode ? 'warn' : 'fail', detail: httpsVersion.statusCode ? 'Site was requested over HTTP; HTTPS is available — redirect HTTP to HTTPS' : 'HTTPS not reachable' });
  }
  if (tlsResult.t) {
    const d = tlsResult.t.daysLeft;
    extras.push({ id: 'tls-expiry', label: 'Certificate expiry', level: d < 0 ? 'fail' : d < 14 ? 'warn' : 'pass', detail: `${d} days left (valid to ${tlsResult.t.validTo.slice(0, 10)})` });
    extras.push({ id: 'tls-trust', label: 'Certificate trust', level: tlsResult.t.authorized ? 'pass' : 'fail', detail: tlsResult.t.authorized ? `Trusted chain, ${tlsResult.t.protocol}` : `Not trusted: ${tlsResult.t.authorizationError}` });
  }
  const origin = new URL(res.finalUrl).origin;
  const [securityTxt, robots] = await Promise.all([
    probe(`${origin}/.well-known/security.txt`, { timeoutMs: 6000, expected: '200' }),
    probe(`${origin}/robots.txt`, { timeoutMs: 6000, expected: '200' }),
  ]);
  extras.push({ id: 'security-txt', label: 'security.txt', level: securityTxt.ok ? 'pass' : 'info', detail: securityTxt.ok ? 'Published' : 'Not found — consider publishing a vulnerability disclosure contact (RFC 9116)' });
  extras.push({ id: 'robots', label: 'robots.txt', level: 'info', detail: robots.ok ? 'Present' : 'Not found' });
  if (res.bodyBytes > 0) extras.push({ id: 'page-weight', label: 'HTML document size', level: res.bodyBytes > 500_000 ? 'warn' : 'info', detail: `${Math.round(res.bodyBytes / 1024)} KB (document only, excluding assets)` });

  return {
    url: url.toString(), finalUrl: res.finalUrl, scannedAt: new Date().toISOString(), reachable: res.statusCode !== null, statusCode: res.statusCode, error: res.error,
    timing: { dnsMs: res.dnsMs, ttfbMs: res.ttfbMs, totalMs: res.latencyMs, bodyBytes: res.bodyBytes }, redirects: res.redirects,
    dns: { a, aaaa, error: dnsErr }, tls: tlsResult.t, tlsError: tlsResult.e, headers, cookies, technology, extras,
    unavailable: [
      'Source code, dependencies and build pipeline — connect the GitHub repository',
      'Server resources, logs and database health — not observable from outside',
      'Real concurrent-user capacity — requires an authorised load test of an environment you own',
      'Availability history — starts once you add this URL as a monitor',
    ],
  };
}
