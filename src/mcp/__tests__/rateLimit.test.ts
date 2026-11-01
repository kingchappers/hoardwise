import { describe, expect, it } from 'vitest';
import { createRequestLimiter } from '../rateLimit';

describe('createRequestLimiter', () => {
  it('allows exactly the limit within a window, per key', () => {
    const limiter = createRequestLimiter({ limit: 3, windowSeconds: 60 });
    const results = [1, 2, 3, 4].map(() => limiter.allow('a', 1000));
    expect(results).toEqual([true, true, true, false]);
    expect(limiter.allow('b', 1000)).toBe(true);
  });

  it('resets once the window has passed', () => {
    const limiter = createRequestLimiter({ limit: 1, windowSeconds: 60 });
    expect(limiter.allow('a', 1000)).toBe(true);
    expect(limiter.allow('a', 1059)).toBe(false);
    expect(limiter.allow('a', 1060)).toBe(true);
  });

  it('drops idle keys so memory stays bounded', () => {
    const limiter = createRequestLimiter({ limit: 1, windowSeconds: 60 });
    for (let i = 0; i < 100; i += 1) limiter.allow(`user-${i}`, 1000);
    limiter.allow('later', 1200);
    expect(limiter.size()).toBe(1);
  });
});
