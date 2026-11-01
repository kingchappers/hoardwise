import { randomBytes, randomUUID } from 'node:crypto';
import { hashToken } from '../auth/localData';
import { LOOKUP_PK, MAX_TOKENS_PER_USER, TokenLimitError, listingPk, revokeToken } from '../auth/tokens';
import { ConditionFailedError, type Item, type Store, type TxOp } from '../store';
import { ACCESS_TTL_SECONDS, type OAuthScope, REFRESH_PK, REFRESH_TTL_SECONDS, REFRESH_USED_PK, isLive } from './types';

const PREFIX_LENGTH = 8;

interface Credentials {
  accessToken: string;
  accessHash: string;
  refreshToken: string;
  refreshHash: string;
}

function newCredentials(scope: OAuthScope): Credentials {
  const accessToken = `${scope === 'write' ? 'hww' : 'hwr'}_${randomBytes(32).toString('base64url')}`;
  const refreshToken = randomBytes(32).toString('base64url');
  return { accessToken, accessHash: hashToken(accessToken), refreshToken, refreshHash: hashToken(refreshToken) };
}

function rowsFor(
  userId: string,
  clientId: string,
  scope: OAuthScope,
  tokenId: string,
  name: string,
  createdAt: number,
  lastUsedAt: number | null,
  creds: Credentials,
  nowSeconds: number,
): TxOp[] {
  const accessExpiresAt = nowSeconds + ACCESS_TTL_SECONDS;
  const refreshExpiresAt = nowSeconds + REFRESH_TTL_SECONDS;
  const record = { tokenId, name, scope, createdAt, lastUsedAt, prefix: creds.accessToken.slice(0, PREFIX_LENGTH), kind: 'oauth' };
  return [
    // The lookup row lives as long as the access token; the listing row as long as the refresh token.
    { put: { PK: LOOKUP_PK, SK: creds.accessHash, ...record, expiresAt: accessExpiresAt, userId } },
    { put: { PK: listingPk(userId), SK: tokenId, ...record, expiresAt: refreshExpiresAt, hash: creds.accessHash, refreshHash: creds.refreshHash, clientId } },
    { put: { PK: REFRESH_PK, SK: creds.refreshHash, userId, tokenId, clientId, scope, expiresAt: refreshExpiresAt }, ifAbsent: true },
  ];
}

export async function createConnection(
  store: Store,
  input: { userId: string; clientId: string; clientName: string; scope: OAuthScope },
  nowSeconds: number,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; tokenId: string }> {
  const listing = await store.query(listingPk(input.userId));
  const replaced = listing.filter((item) => item.kind === 'oauth' && item.clientId === input.clientId);
  if (listing.length - replaced.length >= MAX_TOKENS_PER_USER) throw new TokenLimitError();
  for (const item of replaced) await revokeToken(store, input.userId, String(item.SK));

  const creds = newCredentials(input.scope);
  const tokenId = randomUUID();
  await store.transact(rowsFor(
    input.userId, input.clientId, input.scope, tokenId, input.clientName, nowSeconds, null, creds, nowSeconds,
  ));
  return { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresIn: ACCESS_TTL_SECONDS, tokenId };
}

export async function rotateConnection(
  store: Store,
  refreshToken: string,
  clientId: string,
  nowSeconds: number,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: OAuthScope } | 'invalid' | 'reused'> {
  const oldHash = hashToken(refreshToken);
  const row = await store.get({ PK: REFRESH_PK, SK: oldHash });
  if (!row) {
    const used = await store.get({ PK: REFRESH_USED_PK, SK: oldHash });
    if (!used || !isLive(used, nowSeconds) || used.clientId !== clientId) return 'invalid';
    await revokeToken(store, String(used.userId), String(used.tokenId));
    return 'reused';
  }
  if (!isLive(row, nowSeconds) || row.clientId !== clientId) return 'invalid';

  const userId = String(row.userId);
  const tokenId = String(row.tokenId);
  const scope: OAuthScope = row.scope === 'write' ? 'write' : 'read';
  const listing = await store.get({ PK: listingPk(userId), SK: tokenId });
  if (!listing) return 'invalid';

  const creds = newCredentials(scope);
  const ops: TxOp[] = [
    { delete: { PK: REFRESH_PK, SK: oldHash }, ifPresent: true },
    { put: { PK: REFRESH_USED_PK, SK: oldHash, userId, tokenId, clientId, expiresAt: row.expiresAt as number }, ifAbsent: true },
    { delete: { PK: LOOKUP_PK, SK: String(listing.hash) } },
    ...rowsFor(userId, clientId, scope, tokenId, String(listing.name), Number(listing.createdAt), numberOrNull(listing), creds, nowSeconds),
  ];
  // Revoking deletes the refresh row in the same transaction as the listing row, so the ifPresent delete above fails if the
  // connection was revoked after the reads: a rotation can never bring a revoked connection back.
  try {
    await store.transact(ops);
  } catch (error) {
    if (!(error instanceof ConditionFailedError)) throw error;
    // A concurrent rotation of the same token won, which is indistinguishable from a replay.
    await revokeToken(store, userId, tokenId);
    return 'reused';
  }
  return { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresIn: ACCESS_TTL_SECONDS, scope };
}

function numberOrNull(item: Item): number | null {
  return item.lastUsedAt === null || item.lastUsedAt === undefined ? null : Number(item.lastUsedAt);
}
