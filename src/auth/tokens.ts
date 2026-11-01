import { randomBytes, randomUUID } from 'node:crypto';
import { ConditionFailedError, type Item, type Store, type TxOp } from '../store';
import { REFRESH_PK, REFRESH_USED_PK } from '../oauth/types';
import { hashToken } from './localData';

export type TokenScope = 'read' | 'write';

export const TOKEN_PATTERN = /^hw[rw]_[A-Za-z0-9_-]{43}$/;
export const MAX_TOKENS_PER_USER = 25;
export const MAX_TOKEN_NAME_LENGTH = 60;
export const TOKEN_EXPIRY_DAYS = [90, 180, 365, 730] as const;
export const LAST_USED_INTERVAL_SECONDS = 3600;

const SECONDS_PER_DAY = 24 * 60 * 60;
const PREFIX_LENGTH = 8;
// One shared partition, because Store.query lists a single partition and a lookup must find a token by hash alone.
export const LOOKUP_PK = 'AUTH#TOKENS';

export interface TokenRecord {
  tokenId: string;
  name: string;
  scope: TokenScope;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  prefix: string;
  kind?: 'oauth';
}

export interface StoredToken extends TokenRecord {
  userId: string;
  hash: string;
}

export class TokenLimitError extends Error {
  constructor() {
    super(`A user can have at most ${MAX_TOKENS_PER_USER} tokens`);
    this.name = 'TokenLimitError';
  }
}

export function listingPk(userId: string): string {
  return `AUTH#TOKENLIST#${userId}`;
}

function toRecord(item: Item): TokenRecord {
  return {
    ...(item.kind === 'oauth' ? { kind: 'oauth' as const } : {}),
    tokenId: String(item.tokenId),
    name: String(item.name),
    scope: item.scope === 'write' ? 'write' : 'read',
    createdAt: Number(item.createdAt),
    expiresAt: item.expiresAt === null || item.expiresAt === undefined ? null : Number(item.expiresAt),
    lastUsedAt: item.lastUsedAt === null || item.lastUsedAt === undefined ? null : Number(item.lastUsedAt),
    prefix: String(item.prefix),
  };
}

export async function listTokens(store: Store, userId: string): Promise<TokenRecord[]> {
  const items = await store.query(listingPk(userId));
  return items
    .map(toRecord)
    .sort((a, b) => b.createdAt - a.createdAt || (a.tokenId < b.tokenId ? -1 : 1));
}

export async function createToken(
  store: Store,
  input: { userId: string; name: string; scope: TokenScope; expiryDays: number | null },
  nowSeconds: number,
): Promise<{ token: string; record: TokenRecord }> {
  if ((await listTokens(store, input.userId)).length >= MAX_TOKENS_PER_USER) throw new TokenLimitError();

  const token = `${input.scope === 'write' ? 'hww' : 'hwr'}_${randomBytes(32).toString('base64url')}`;
  const hash = hashToken(token);
  const record: TokenRecord = {
    tokenId: randomUUID(),
    name: input.name,
    scope: input.scope,
    createdAt: nowSeconds,
    expiresAt: input.expiryDays === null ? null : nowSeconds + input.expiryDays * SECONDS_PER_DAY,
    lastUsedAt: null,
    prefix: token.slice(0, PREFIX_LENGTH),
  };

  // The lookup item carries the whole record so authenticating a request costs one read.
  await store.transact([
    { put: { PK: LOOKUP_PK, SK: hash, ...record, userId: input.userId } },
    { put: { PK: listingPk(input.userId), SK: record.tokenId, ...record, hash } },
  ]);
  return { token, record };
}

export async function findToken(store: Store, token: string, nowSeconds: number): Promise<StoredToken | undefined> {
  const hash = hashToken(token);
  const item = await store.get({ PK: LOOKUP_PK, SK: hash });
  if (!item) return undefined;

  const record = toRecord(item);
  // The TTL purge is hourly, so a row past its expiry can still be read: valid only while expiresAt > now.
  if (record.expiresAt !== null && !(record.expiresAt > nowSeconds)) return undefined;
  return { ...record, userId: String(item.userId), hash };
}

// Both patches use mustExist, so a token revoked mid-request is not brought back; the caller handles ConditionFailedError.
export async function touchToken(store: Store, stored: StoredToken, nowSeconds: number): Promise<void> {
  if (stored.lastUsedAt !== null && nowSeconds - stored.lastUsedAt < LAST_USED_INTERVAL_SECONDS) return;
  const fields = { lastUsedAt: nowSeconds };
  await store.patch({ PK: LOOKUP_PK, SK: stored.hash }, fields, { mustExist: true });
  await store.patch({ PK: listingPk(stored.userId), SK: stored.tokenId }, fields, { mustExist: true });
}

const MAX_REVOKE_ATTEMPTS = 3;

function revokeOps(userId: string, tokenId: string, listing: Item, requireRefresh: boolean): TxOp[] {
  const ops: TxOp[] = [
    { delete: { PK: LOOKUP_PK, SK: String(listing.hash) } },
    { delete: { PK: listingPk(userId), SK: tokenId } },
  ];
  // An OAuth connection's refresh row goes in the same transaction. It is required to exist: a rotation deletes the old
  // refresh row, so a rotation that committed after the listing was read makes this fail instead of deleting stale hashes.
  if (typeof listing.refreshHash === 'string') {
    ops.push({ delete: { PK: REFRESH_PK, SK: listing.refreshHash }, ifPresent: requireRefresh });
  }
  return ops;
}

export async function revokeToken(store: Store, userId: string, tokenId: string): Promise<boolean> {
  let listing = await store.get({ PK: listingPk(userId), SK: tokenId });
  if (!listing) return false;

  for (let attempt = 0; attempt < MAX_REVOKE_ATTEMPTS; attempt++) {
    try {
      await store.transact(revokeOps(userId, tokenId, listing, true));
      return true;
    } catch (error) {
      if (!(error instanceof ConditionFailedError)) throw error;
    }
    const current = await store.get({ PK: listingPk(userId), SK: tokenId });
    if (!current) return true;
    if (current.refreshHash === listing.refreshHash) {
      // The hashes did not move, so the refresh row is gone for another reason (its TTL purge): a live connection must still be revocable.
      await store.transact(revokeOps(userId, tokenId, current, false));
      return true;
    }
    listing = current;
  }
  throw new Error('Could not revoke the token because it kept changing');
}

const MAX_SWEEP_PASSES = 3;

async function deleteAll(store: Store, rows: Item[]): Promise<void> {
  for (const { PK, SK } of rows) await store.delete({ PK, SK });
}

// Used on password recovery. Refresh rows go first: a rotation needs its old refresh row to exist, so one racing the sweep fails
// instead of recreating a connection, and anything it did slip in is caught by the next pass.
export async function revokeAllTokens(store: Store): Promise<void> {
  for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
    const refresh = await store.query(REFRESH_PK);
    const used = await store.query(REFRESH_USED_PK);
    await deleteAll(store, refresh);
    await deleteAll(store, used);

    const lookups = await store.query(LOOKUP_PK);
    const userIds = new Set([...lookups, ...refresh, ...used].map((item) => String(item.userId)));
    for (const userId of userIds) await deleteAll(store, await store.query(listingPk(userId)));
    await deleteAll(store, lookups);

    const leftovers = [REFRESH_PK, REFRESH_USED_PK, LOOKUP_PK];
    const remaining = (await Promise.all([
      ...leftovers.map((pk) => store.query(pk)),
      ...[...userIds].map((userId) => store.query(listingPk(userId))),
    ])).flat();
    if (remaining.length === 0) return;
  }
}
