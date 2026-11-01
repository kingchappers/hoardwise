export interface RequestLimiterOptions {
  limit: number;
  windowSeconds: number;
}

export interface RequestLimiter {
  allow(key: string, nowSeconds: number): boolean;
  size(): number;
}

interface Window {
  start: number;
  count: number;
}

// Fixed window per key, in memory. Expired windows are swept at most once per window so the map stays bounded.
export function createRequestLimiter({ limit, windowSeconds }: RequestLimiterOptions): RequestLimiter {
  const windows = new Map<string, Window>();
  let lastSweep = 0;

  function sweep(nowSeconds: number): void {
    if (nowSeconds - lastSweep < windowSeconds) return;
    lastSweep = nowSeconds;
    for (const [key, entry] of windows) {
      if (nowSeconds - entry.start >= windowSeconds) windows.delete(key);
    }
  }

  function allow(key: string, nowSeconds: number): boolean {
    sweep(nowSeconds);
    const entry = windows.get(key);
    if (!entry || nowSeconds - entry.start >= windowSeconds) {
      windows.set(key, { start: nowSeconds, count: 1 });
      return limit >= 1;
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  return { allow, size: () => windows.size };
}
