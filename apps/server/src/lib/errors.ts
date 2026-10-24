export class HttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, message: string, code = 'error') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg, 'bad_request');
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'not_found');
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg, 'forbidden');
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg, 'unauthorized');
export const conflict = (msg: string) => new HttpError(409, msg, 'conflict');

/** Redact anything that looks like a credential before it reaches logs, UI or DB. */
export function redact(text: string): string {
  return text
    .replace(/(gh[pousr]_[A-Za-z0-9]{6})[A-Za-z0-9]{10,}/g, '$1…[REDACTED]')
    .replace(/(github_pat_[A-Za-z0-9]{6})[A-Za-z0-9_]{10,}/g, '$1…[REDACTED]')
    .replace(/((?:AKIA|ASIA)[A-Z0-9]{4})[A-Z0-9]{12}/g, '$1…[REDACTED]')
    .replace(/(xox[abprs]-[A-Za-z0-9]{4})[A-Za-z0-9-]{6,}/g, '$1…[REDACTED]')
    .replace(/(sk_(?:live|test)_[A-Za-z0-9]{4})[A-Za-z0-9]{10,}/g, '$1…[REDACTED]')
    .replace(/(AIza[0-9A-Za-z_-]{4})[0-9A-Za-z_-]{20,}/g, '$1…[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '-----BEGIN PRIVATE KEY----- [REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?)[^\s"']{4,}/gi, '$1[REDACTED]');
}
