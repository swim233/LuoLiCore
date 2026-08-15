import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export class Secrets {
  readonly #key: Buffer | null;

  constructor(masterKey?: string) {
    this.#key = masterKey ? createHash('sha256').update(masterKey).digest() : null;
  }

  get available(): boolean {
    return this.#key !== null;
  }

  encrypt(value: string): string {
    if (!this.#key) throw new Error('LUOLI_MASTER_KEY is unavailable');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  decrypt(value: string): string {
    if (!this.#key) throw new Error('LUOLI_MASTER_KEY is unavailable');
    const [version, ivRaw, cipherRaw, tagRaw] = value.split('.');
    if (version !== 'v1' || !ivRaw || !cipherRaw || !tagRaw) throw new Error('Unsupported encrypted value');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(cipherRaw, 'base64url')), decipher.final()]).toString('utf8');
  }
}

const BUILTIN_REDACTIONS = [
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /Bearer\s+\S+/gi,
];
const STRUCTURAL_FIELDS = new Set(['key', 'kind', 'traceId', 'spanId', 'parentSpanId', 'chatId', 'userId']);
const SENSITIVE_FIELD = /(^|_|\b)(api[_-]?key|apikey|secret|token|password|passwd|credential)s?($|_|\b)/i;

export function redact<T>(value: T, secrets: string[] = []): T {
  const sanitizeString = (input: string): string => {
    let output = input;
    for (const pattern of BUILTIN_REDACTIONS) output = output.replace(pattern, '«redacted»');
    for (const secret of secrets.filter(Boolean)) output = output.replaceAll(secret, '«redacted»');
    return output;
  };
  const sanitize = (input: unknown, key = ''): unknown => {
    if (!STRUCTURAL_FIELDS.has(key) && SENSITIVE_FIELD.test(key) && typeof input === 'string' && input.length > 0) return '«redacted»';
    if (typeof input === 'string') return sanitizeString(input);
    if (Array.isArray(input)) return input.map((item) => sanitize(item));
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([name, nested]) => [name, sanitize(nested, name)]));
    return input;
  };
  return sanitize(value) as T;
}
