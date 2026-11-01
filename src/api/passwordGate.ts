import { getAuth } from '../auth';
import { clearThrottle, getAccount, recordFailure, throttleRemaining } from '../auth/localData';
import type { Account } from '../auth/localData';
import { verifyPassword } from '../auth/password';
import { serialisedPasswordAttempt } from '../auth/passwordAttempts';
import type { TokenScope } from '../auth/tokens';
import type { Store } from '../store';
import { err } from './http';
import type { ApiResponse } from './types';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Returns a refusal, or null when the caller may go on to create the token. Shares the login route's queue, so
// guesses here and at login together are still checked one at a time against the one throttle.
export function checkPassword(store: Store, password: string | undefined): Promise<ApiResponse | null> {
  return serialisedPasswordAttempt(() => attemptPassword(store, password));
}

async function attemptPassword(store: Store, password: string | undefined): Promise<ApiResponse | null> {
  const now = nowSeconds();
  const wait = await throttleRemaining(store, now);
  if (wait > 0) {
    const limited = err(429, 'Too many attempts', { retryAfter: wait });
    return { ...limited, headers: { ...limited.headers, 'Retry-After': String(wait) } };
  }
  if (password === undefined) return err(403, 'Password required');

  const account = await getAccount(store);
  if (!account || !(await passwordMatches(password, account))) {
    await recordFailure(store, now);
    return err(403, 'Incorrect password');
  }
  await clearThrottle(store);
  return null;
}

async function passwordMatches(password: string, account: Account): Promise<boolean> {
  try {
    return await verifyPassword(password, account);
  } catch (error) {
    console.error('Stored account password record could not be verified:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

export function needsPassword(scope: TokenScope): boolean {
  return getAuth().mode === 'local' && scope === 'write';
}
