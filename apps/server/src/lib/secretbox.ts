import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Encrypts small secrets at rest (e.g. webhook URLs that embed tokens) with AES-256-GCM.
 * The key lives in `<dataDir>/secret.key`, generated on first use and never stored in the
 * database or source. Copying only the database therefore does not reveal the secrets.
 */
export class SecretBox {
  private key: Buffer;

  constructor(dataDir: string) {
    const file = path.join(dataDir, 'secret.key');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${file} is not a valid 32-byte key`);
    this.key = key;
  }

  seal(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported secret format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/** `https://hooks.slack.com/services/T0/B0/xyz` → `https://hooks.slack.com/…` (safe to display). */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '(invalid URL)';
  }
}
