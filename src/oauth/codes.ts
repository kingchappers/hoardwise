import { randomBytes } from 'node:crypto';
import { hashToken } from '../auth/localData';
import { ConditionFailedError, type Store } from '../store';
import { CODES_PK, CODE_TTL_SECONDS, type OAuthScope, isLive } from './types';

export interface StoredCode {
  clientId: string;
  userId: string;
  scope: OAuthScope;
  redirectUri: string;
  codeChallenge: string;
}

export async function issueCode(
  store: Store,
  input: StoredCode,
  nowSeconds: number,
): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await store.put({
    PK: CODES_PK,
    SK: hashToken(code),
    clientId: input.clientId,
    userId: input.userId,
    scope: input.scope,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    createdAt: nowSeconds,
    expiresAt: nowSeconds + CODE_TTL_SECONDS,
  }, { ifAbsent: true });
  return code;
}

// A code works once: the delete requires the row, so of two simultaneous exchanges only one succeeds.
export async function consumeCode(store: Store, code: string, nowSeconds: number): Promise<StoredCode | undefined> {
  const key = { PK: CODES_PK, SK: hashToken(code) };
  const item = await store.get(key);
  if (!item) return undefined;
  try {
    await store.delete(key, { ifPresent: true });
  } catch (error) {
    if (error instanceof ConditionFailedError) return undefined;
    throw error;
  }
  if (!isLive(item, nowSeconds)) return undefined;
  return {
    clientId: String(item.clientId),
    userId: String(item.userId),
    scope: item.scope === 'write' ? 'write' : 'read',
    redirectUri: String(item.redirectUri),
    codeChallenge: String(item.codeChallenge),
  };
}
