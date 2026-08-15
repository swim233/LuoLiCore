import { describe, expect, it } from 'vitest';
import { Secrets, redact } from '@luoli/core';

describe('secret handling', () => {
  it('encrypts provider keys with randomized AES-GCM values', () => {
    const secrets = new Secrets('a'.repeat(32));
    const first = secrets.encrypt('sk-example-secret-value');
    const second = secrets.encrypt('sk-example-secret-value');
    expect(first).not.toBe(second);
    expect(first).not.toContain('sk-example');
    expect(secrets.decrypt(first)).toBe('sk-example-secret-value');
  });

  it('redacts keys, bearer values, and Telegram tokens', () => {
    const value = redact({ openai: 'sk-abcdefghijklmnop', auth: 'Bearer topsecret', bot: '12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(JSON.stringify(value)).not.toContain('topsecret');
    expect(JSON.stringify(value)).not.toContain('abcdefghijklmnop');
  });

  it('preserves structural dimensions while redacting secret fields and values', () => {
    const value = redact({ key: 'chat:-100123', chatId: '-100123', traceId: 'trace-1', apiKey: 'visible-api-value', api_key: 'visible-api-value', token: 'visible-token', nested: { password: 'visible-password' }, text: 'sk-abcdefghijklmnop' });
    expect(value.key).toBe('chat:-100123');
    expect(value.chatId).toBe('-100123');
    expect(value.traceId).toBe('trace-1');
    expect(value.apiKey).toBe('«redacted»');
    expect(value.api_key).toBe('«redacted»');
    expect(value.token).toBe('«redacted»');
    expect(value.nested.password).toBe('«redacted»');
    expect(value.text).toBe('«redacted»');
  });
});
