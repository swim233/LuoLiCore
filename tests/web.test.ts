import { describe, expect, it } from 'vitest';
import { webFetch } from '@luoli/core';

describe('web fetch SSRF guard', () => {
  it('rejects link-local and loopback targets before fetching', async () => {
    await expect(webFetch('http://169.254.169.254/latest/meta-data', 1024, new AbortController().signal)).rejects.toThrow('ssrf_blocked');
    await expect(webFetch('http://127.0.0.1:8787', 1024, new AbortController().signal)).rejects.toThrow('ssrf_blocked');
    await expect(webFetch('http://[::ffff:127.0.0.1]/', 1024, new AbortController().signal)).rejects.toThrow('ssrf_blocked');
    await expect(webFetch('http://0.0.0.0/', 1024, new AbortController().signal)).rejects.toThrow('ssrf_blocked');
  });
});
