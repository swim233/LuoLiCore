import { createCipheriv, createHash, randomBytes } from 'node:crypto';
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

  // 换 KDF 不能把已经存好的 provider key 变成解不开的垃圾（docs/20 · W-SEC-02）。
  it('still decrypts v1 ciphertext while writing v2', () => {
    const master = 'a'.repeat(32);
    const legacyKey = createHash('sha256').update(master).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
    const body = Buffer.concat([cipher.update('sk-legacy-value', 'utf8'), cipher.final()]);
    const legacy = `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
    const secrets = new Secrets(master);
    expect(Secrets.isLegacy(legacy)).toBe(true);
    expect(secrets.decrypt(legacy)).toBe('sk-legacy-value');
    const upgraded = secrets.encrypt('sk-legacy-value');
    expect(Secrets.isLegacy(upgraded)).toBe(false);
    expect(secrets.decrypt(upgraded)).toBe('sk-legacy-value');
    // 同一份明文两次加密的 salt 不同，密文自然也不同。
    expect(secrets.encrypt('sk-legacy-value')).not.toBe(upgraded);
    expect(new Secrets('short').weak).toBe(true);
    expect(secrets.weak).toBe(false);
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
