import { describe, expect, it } from 'vitest';
import { webFetch } from '@luoli/core';

describe('web fetch SSRF guard', () => {
  it('rejects private, reserved, tunneled, and non-HTTP ports before fetching', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/',
      'http://198.18.0.1/', 'http://192.0.2.1/', 'http://198.51.100.1/', 'http://203.0.113.1/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/']) {
      await expect(webFetch(url, 1024, new AbortController().signal)).rejects.toThrow('ssrf_blocked');
    }
    await expect(webFetch('http://127.0.0.1:8787', 1024, new AbortController().signal)).rejects.toThrow('port_blocked');
    await expect(webFetch('http://example.com:6379/', 1024, new AbortController().signal)).rejects.toThrow('port_blocked');
  });
});
