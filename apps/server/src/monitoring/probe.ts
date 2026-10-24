import dns from 'node:dns/promises';
import tls from 'node:tls';

export interface ProbeResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  dnsMs: number | null;
  error: string | null;
  redirects: { status: number; location: string }[];
  finalUrl: string;
  headers: Record<string, string>;
  setCookies: string[];
  bodyBytes: number;
  body: string | null;
  ttfbMs: number | null;
}

export function validateTargetUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a full URL including https://');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http:// and https:// URLs are supported.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.');
  return url;
}

export function statusMatches(code: number, spec: string): boolean {
  return spec.split(',').some((part) => {
    const [a, b] = part.trim().split('-').map(Number);
    return b === undefined ? code === a : code >= a! && code <= b;
  });
}

/**
 * A single bounded HTTP probe. Redirects are followed manually (max 5) so each hop is
 * recorded; the body is read up to `maxBody` bytes and discarded unless requested.
 */
export async function probe(
  target: string,
  opts: { method?: string; timeoutMs: number; expected?: string; keepBody?: boolean; maxBody?: number } = { timeoutMs: 10_000 },
): Promise<ProbeResult> {
  const result: ProbeResult = {
    ok: false, statusCode: null, latencyMs: null, dnsMs: null, error: null, redirects: [], finalUrl: target, headers: {}, setCookies: [], bodyBytes: 0, body: null, ttfbMs: null,
  };
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  const started = performance.now();
  try {
    const host = new URL(target).hostname;
    const d0 = performance.now();
    if (!/^[\d.]+$|^\[/.test(host)) await dns.lookup(host);
    result.dnsMs = Math.round(performance.now() - d0);

    let url = target;
    for (let hop = 0; hop <= 5; hop++) {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        redirect: 'manual',
        signal: deadline,
        headers: { 'User-Agent': 'SentinelOps-Monitor/0.1 (+health check)', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      });
      if (result.ttfbMs === null) result.ttfbMs = Math.round(performance.now() - started);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location && hop < 5) {
        result.redirects.push({ status: res.status, location });
        await res.body?.cancel();
        url = new URL(location, url).toString();
        continue;
      }
      result.statusCode = res.status;
      result.finalUrl = url;
      res.headers.forEach((v, k) => {
        if (k !== 'set-cookie') result.headers[k] = v.slice(0, 500);
      });
      result.setCookies = res.headers.getSetCookie?.() ?? [];
      const max = opts.maxBody ?? 512 * 1024;
      const chunks: Buffer[] = [];
      if (res.body) {
        const reader = res.body.getReader();
        while (result.bodyBytes < max) {
          const { done, value } = await reader.read();
          if (done) break;
          result.bodyBytes += value.byteLength;
          if (opts.keepBody) chunks.push(Buffer.from(value));
        }
        await reader.cancel().catch(() => {});
      }
      if (opts.keepBody) result.body = Buffer.concat(chunks).toString('utf8').slice(0, max);
      break;
    }
    result.latencyMs = Math.round(performance.now() - started);
    result.ok = result.statusCode !== null && statusMatches(result.statusCode, opts.expected ?? '200-399');
    if (!result.ok && result.statusCode !== null) result.error = `Unexpected HTTP status ${result.statusCode}`;
  } catch (err) {
    result.latencyMs = Math.round(performance.now() - started);
    result.error = describeError(err);
  }
  return result;
}

function describeError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string }; code?: string };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'Timed out';
  const code = e.cause?.code ?? e.code;
  const map: Record<string, string> = {
    ENOTFOUND: 'DNS lookup failed (ENOTFOUND)', EAI_AGAIN: 'DNS lookup failed temporarily (EAI_AGAIN)', ECONNREFUSED: 'Connection refused',
    ECONNRESET: 'Connection reset', CERT_HAS_EXPIRED: 'TLS certificate has expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate chain could not be verified', ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the host name',
    UND_ERR_CONNECT_TIMEOUT: 'Connection timed out',
  };
  return (code && map[code]) || `${code ? `${code}: ` : ''}${e.cause?.message ?? e.message}`.slice(0, 200);
}

export interface TlsInfo {
  validFrom: string;
  validTo: string;
  daysLeft: number;
  issuer: string;
  subject: string;
  protocol: string | null;
  authorized: boolean;
  authorizationError: string | null;
  altNames: string[];
}

export function tlsInfo(host: string, port = 443, timeoutMs = 8000): Promise<TlsInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = new Date(cert.valid_to);
      resolve({
        validFrom: new Date(cert.valid_from).toISOString(),
        validTo: validTo.toISOString(),
        daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
        issuer: [cert.issuer?.O, cert.issuer?.CN].flat().filter(Boolean).join(' / '),
        subject: String(cert.subject?.CN ?? ''),
        protocol: socket.getProtocol(),
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        altNames: (cert.subjectaltname ?? '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean).slice(0, 20),
      });
      socket.end();
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('TLS handshake timed out'));
    });
    socket.on('error', reject);
  });
}
