import { describe, expect, it } from 'vitest';
import { ModelRegistry, retryDelay } from '@luoli/core';

describe('provider retry policy', () => {
  it('honors retry-after and caps exponential backoff', () => {
    expect(retryDelay(0, 12_000, 1000, 30_000)).toBe(12_000);
    expect(retryDelay(10, null, 1000, 30_000)).toBeLessThanOrEqual(30_000);
    expect(retryDelay(1, null, 1000, 30_000)).toBeGreaterThanOrEqual(1600);
  });

  it('estimates reservations from configured input and output prices', () => {
    const registry = Object.create(ModelRegistry.prototype) as ModelRegistry;
    expect(registry.estimateModel({ priceIn: 2, priceOut: 10, maxOutput: 2000 }, 4000)).toBeCloseTo(0.018, 12);
    expect(registry.estimateModel({ priceIn: null, priceOut: 10, maxOutput: 2000 }, 4000)).toBeNull();
  });
});
