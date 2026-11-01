import { createRequestLimiter } from './rateLimit';
import type { RequestLimiter } from './rateLimit';

const WRITES_PER_WINDOW = 30;
const WINDOW_SECONDS = 600;

function createWriteLimiter(): RequestLimiter {
  return createRequestLimiter({ limit: WRITES_PER_WINDOW, windowSeconds: WINDOW_SECONDS });
}

let writeLimiter = createWriteLimiter();

// The limit is per server instance: on AWS each Lambda instance counts separately, and the per-request limiter also applies.
// Every attempt counts, successful or not, so a looping assistant cannot flood a budget with entries.
export function allowWrite(userId: string, now: Date): boolean {
  return writeLimiter.allow(userId, Math.floor(now.getTime() / 1000));
}

// For tests: module-scope state must not leak between them.
export function resetWriteLimit(): void {
  writeLimiter = createWriteLimiter();
}
