import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_TOKENS_PER_USER, TokenLimitError, createToken, findToken, listTokens, revokeAllTokens, revokeToken } from '../../auth/tokens';
import { hashToken } from '../../auth/localData';
import { MemoryStore } from '../../store/memory';
import { createConnection, rotateConnection } from '../connections';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from '../types';

let store: MemoryStore;
const NOW = 1_800_000_000;
const input = { userId: 'u1', clientId: 'c1', clientName: 'Claude', scope: 'write' as const };

beforeEach(() => { store = new MemoryStore(); });

describe('createConnection', () => {
  it('makes an access token findToken resolves and a listing row of kind oauth', async () => {
    const conn = await createConnection(store, input, NOW);
    expect(conn.accessToken).toMatch(/^hww_[A-Za-z0-9_-]{43}$/);
    expect(conn.expiresIn).toBe(ACCESS_TTL_SECONDS);
    const found = await findToken(store, conn.accessToken, NOW + 10);
    expect(found).toMatchObject({ userId: 'u1', scope: 'write', tokenId: conn.tokenId });
    expect(await findToken(store, conn.accessToken, NOW + ACCESS_TTL_SECONDS)).toBeUndefined();

    const listed = await listTokens(store, 'u1');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      tokenId: conn.tokenId, name: 'Claude', kind: 'oauth', scope: 'write', expiresAt: NOW + REFRESH_TTL_SECONDS,
    });
  });

  it('gives a read scope an hwr_ token', async () => {
    const conn = await createConnection(store, { ...input, scope: 'read' }, NOW);
    expect(conn.accessToken.startsWith('hwr_')).toBe(true);
  });

  it('stores only hashes of the access and refresh tokens', async () => {
    const conn = await createConnection(store, input, NOW);
    const rows = [
      ...await store.query('AUTH#TOKENS'), ...await store.query('AUTH#TOKENLIST#u1'), ...await store.query('OAUTH#REFRESH'),
    ];
    const text = JSON.stringify(rows);
    expect(text).not.toContain(conn.accessToken);
    expect(text).not.toContain(conn.refreshToken);
    const refresh = await store.query('OAUTH#REFRESH');
    expect(refresh[0].SK).toBe(hashToken(conn.refreshToken));
    expect(refresh[0].expiresAt).toBe(NOW + REFRESH_TTL_SECONDS);
  });

  it('revokes an earlier connection for the same user and client', async () => {
    const first = await createConnection(store, input, NOW);
    const second = await createConnection(store, input, NOW + 5);
    expect(await findToken(store, first.accessToken, NOW + 6)).toBeUndefined();
    expect(await findToken(store, second.accessToken, NOW + 6)).toBeDefined();
    expect(await listTokens(store, 'u1')).toHaveLength(1);
    expect(await rotateConnection(store, first.refreshToken, 'c1', NOW + 6)).toBe('invalid');
  });

  it('keeps connections of other clients and users', async () => {
    const other = await createConnection(store, { ...input, clientId: 'c2' }, NOW);
    await createConnection(store, { ...input, userId: 'u2' }, NOW);
    await createConnection(store, input, NOW);
    expect(await findToken(store, other.accessToken, NOW + 1)).toBeDefined();
  });

  it('throws TokenLimitError at the cap without revoking anything', async () => {
    for (let i = 0; i < MAX_TOKENS_PER_USER; i++) {
      await createToken(store, { userId: 'u1', name: `t${i}`, scope: 'read', expiryDays: 90 }, NOW + i);
    }
    await expect(createConnection(store, input, NOW + 100)).rejects.toBeInstanceOf(TokenLimitError);
  });

  it('allows a replacement connection at the cap', async () => {
    await createConnection(store, input, NOW);
    for (let i = 0; i < MAX_TOKENS_PER_USER - 1; i++) {
      await createToken(store, { userId: 'u1', name: `t${i}`, scope: 'read', expiryDays: 90 }, NOW + i);
    }
    await expect(createConnection(store, input, NOW + 100)).resolves.toBeDefined();
  });
});

describe('rotateConnection', () => {
  it('returns new tokens under the same tokenId and retires the old access token', async () => {
    const conn = await createConnection(store, input, NOW);
    const next = await rotateConnection(store, conn.refreshToken, 'c1', NOW + 100);
    if (typeof next === 'string') throw new Error(next);
    expect(next.scope).toBe('write');
    expect(next.expiresIn).toBe(ACCESS_TTL_SECONDS);
    expect(next.refreshToken).not.toBe(conn.refreshToken);
    expect(await findToken(store, conn.accessToken, NOW + 101)).toBeUndefined();
    expect(await findToken(store, next.accessToken, NOW + 101)).toMatchObject({ tokenId: conn.tokenId });
    const listed = await listTokens(store, 'u1');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tokenId: conn.tokenId, kind: 'oauth', expiresAt: NOW + 100 + REFRESH_TTL_SECONDS });
    expect(listed[0].prefix).toBe(next.accessToken.slice(0, 8));
  });

  it('works after the access token has expired', async () => {
    const conn = await createConnection(store, input, NOW);
    const next = await rotateConnection(store, conn.refreshToken, 'c1', NOW + ACCESS_TTL_SECONDS + 500);
    expect(typeof next).toBe('object');
  });

  it('treats a reused refresh token as theft: reused, and the whole connection is revoked', async () => {
    const conn = await createConnection(store, input, NOW);
    const next = await rotateConnection(store, conn.refreshToken, 'c1', NOW + 100);
    if (typeof next === 'string') throw new Error(next);
    expect(await rotateConnection(store, conn.refreshToken, 'c1', NOW + 200)).toBe('reused');
    expect(await findToken(store, next.accessToken, NOW + 201)).toBeUndefined();
    expect(await listTokens(store, 'u1')).toHaveLength(0);
    expect(await rotateConnection(store, next.refreshToken, 'c1', NOW + 202)).toBe('invalid');
  });

  it('lets only one of two concurrent rotations win', async () => {
    const conn = await createConnection(store, input, NOW);
    const results = await Promise.all([
      rotateConnection(store, conn.refreshToken, 'c1', NOW + 10), rotateConnection(store, conn.refreshToken, 'c1', NOW + 10),
    ]);
    expect(results.filter((r) => typeof r === 'object')).toHaveLength(1);
    expect(results.filter((r) => r === 'reused')).toHaveLength(1);
  });

  it('is invalid for an unknown token, another client, or an expired refresh token', async () => {
    const conn = await createConnection(store, input, NOW);
    expect(await rotateConnection(store, 'nope', 'c1', NOW + 1)).toBe('invalid');
    expect(await rotateConnection(store, conn.refreshToken, 'other', NOW + 1)).toBe('invalid');
    expect(await rotateConnection(store, conn.refreshToken, 'c1', NOW + REFRESH_TTL_SECONDS)).toBe('invalid');
    expect(await findToken(store, conn.accessToken, NOW + 2)).toBeDefined();
  });

  it('is invalid once the connection was revoked from the token list', async () => {
    const conn = await createConnection(store, input, NOW);
    expect(await revokeToken(store, 'u1', conn.tokenId)).toBe(true);
    expect(await rotateConnection(store, conn.refreshToken, 'c1', NOW + 1)).toBe('invalid');
  });
});

describe('revokeToken on a connection', () => {
  it('also removes the refresh row', async () => {
    const conn = await createConnection(store, input, NOW);
    await revokeToken(store, 'u1', conn.tokenId);
    expect(await store.query('OAUTH#REFRESH')).toHaveLength(0);
    expect(await store.query('AUTH#TOKENS')).toHaveLength(0);
  });
});

class RacingStore extends MemoryStore {
  beforeTransact: (() => Promise<void>) | undefined;
  afterTransact: (() => Promise<void>) | undefined;
  afterQuery: (() => Promise<void>) | undefined;
  afterListingGet: (() => Promise<void>) | undefined;

  override async get(key: Parameters<MemoryStore['get']>[0]) {
    const item = await super.get(key);
    const hook = key.PK.startsWith('AUTH#TOKENLIST#') ? this.afterListingGet : undefined;
    if (hook) {
      this.afterListingGet = undefined;
      await hook();
    }
    return item;
  }

  override async transact(ops: Parameters<MemoryStore['transact']>[0]): Promise<void> {
    const before = this.beforeTransact;
    this.beforeTransact = undefined;
    if (before) await before();
    await super.transact(ops);
    const after = this.afterTransact;
    this.afterTransact = undefined;
    if (after) await after();
  }

  override async query(pk: string, opts?: Parameters<MemoryStore['query']>[1]) {
    const rows = await super.query(pk, opts);
    const hook = this.afterQuery;
    this.afterQuery = undefined;
    if (hook) await hook();
    return rows;
  }
}

describe('revoke racing a rotation', () => {
  it('keeps a connection dead when a rotation read the listing before revoke ran its first write and commits after it', async () => {
    const racing = new RacingStore();
    const conn = await createConnection(racing, input, NOW);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let revoking: Promise<boolean> | undefined;
    let firstWriteDone: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => { firstWriteDone = resolve; });

    // The rotation has read the listing; revoke now runs its first write and pauses before its next call.
    racing.afterListingGet = async () => {
      racing.afterTransact = async () => { firstWriteDone(); await gate; };
      revoking = revokeToken(racing, 'u1', conn.tokenId);
      await firstWrite;
    };
    await rotateConnection(racing, conn.refreshToken, 'c1', NOW + 10);
    release();
    await revoking;

    expect(await findToken(racing, conn.accessToken, NOW + 11)).toBeUndefined();
    expect(await listTokens(racing, 'u1')).toHaveLength(0);
    expect(await racing.query('AUTH#TOKENS')).toHaveLength(0);
    expect(await racing.query('OAUTH#REFRESH')).toHaveLength(0);
    expect(await rotateConnection(racing, conn.refreshToken, 'c1', NOW + 12)).toMatch(/^(invalid|reused)$/);
  });

  it('revokes the new tokens when a rotation commits between revoke reading the listing and writing', async () => {
    const racing = new RacingStore();
    const conn = await createConnection(racing, input, NOW);
    let next: Awaited<ReturnType<typeof rotateConnection>> | undefined;
    racing.beforeTransact = async () => { next = await rotateConnection(racing, conn.refreshToken, 'c1', NOW + 10); };

    expect(await revokeToken(racing, 'u1', conn.tokenId)).toBe(true);

    if (typeof next !== 'object') throw new Error('the rotation should have won');
    expect(await findToken(racing, conn.accessToken, NOW + 11)).toBeUndefined();
    expect(await findToken(racing, next.accessToken, NOW + 11)).toBeUndefined();
    expect(await rotateConnection(racing, next.refreshToken, 'c1', NOW + 12)).toMatch(/^(invalid|reused)$/);
    expect(await racing.query('AUTH#TOKENS')).toHaveLength(0);
    expect(await racing.query('OAUTH#REFRESH')).toHaveLength(0);
    expect(await listTokens(racing, 'u1')).toHaveLength(0);
  });

  it('still revokes a connection whose refresh row was purged by its TTL', async () => {
    const conn = await createConnection(store, input, NOW);
    await store.delete({ PK: 'OAUTH#REFRESH', SK: hashToken(conn.refreshToken) });
    expect(await revokeToken(store, 'u1', conn.tokenId)).toBe(true);
    expect(await findToken(store, conn.accessToken, NOW + 1)).toBeUndefined();
    expect(await listTokens(store, 'u1')).toHaveLength(0);
  });
});

describe('rotateConnection across users', () => {
  it('does not revoke another user connection when the refresh token is presented with a different client', async () => {
    const a = await createConnection(store, input, NOW);
    await createConnection(store, { ...input, userId: 'u2', clientId: 'c2' }, NOW);
    expect(await rotateConnection(store, a.refreshToken, 'c2', NOW + 1)).toBe('invalid');
    expect(await findToken(store, a.accessToken, NOW + 2)).toBeDefined();
    expect(typeof await rotateConnection(store, a.refreshToken, 'c1', NOW + 3)).toBe('object');
  });

  it('does not revoke when a rotated token is replayed under a different client', async () => {
    const a = await createConnection(store, input, NOW);
    const next = await rotateConnection(store, a.refreshToken, 'c1', NOW + 1);
    if (typeof next === 'string') throw new Error(next);
    expect(await rotateConnection(store, a.refreshToken, 'c2', NOW + 2)).toBe('invalid');
    expect(await findToken(store, next.accessToken, NOW + 3)).toBeDefined();
  });
});

describe('revokeAllTokens with connections', () => {
  it('removes every OAuth row so no refresh token survives', async () => {
    const a = await createConnection(store, input, NOW);
    const b = await createConnection(store, { ...input, userId: 'u2', clientId: 'c2' }, NOW);
    const rotated = await rotateConnection(store, b.refreshToken, 'c2', NOW + 1);
    if (typeof rotated === 'string') throw new Error(rotated);
    expect(await store.query('OAUTH#REFRESH-USED')).toHaveLength(1);

    await revokeAllTokens(store);

    expect(await rotateConnection(store, a.refreshToken, 'c1', NOW + 2)).toBe('invalid');
    expect(await rotateConnection(store, rotated.refreshToken, 'c2', NOW + 2)).toBe('invalid');
    expect(await rotateConnection(store, b.refreshToken, 'c2', NOW + 2)).toBe('invalid');
    expect(await store.query('OAUTH#REFRESH')).toHaveLength(0);
    expect(await store.query('OAUTH#REFRESH-USED')).toHaveLength(0);
    expect(await store.query('AUTH#TOKENS')).toHaveLength(0);
    expect(await listTokens(store, 'u1')).toHaveLength(0);
    expect(await listTokens(store, 'u2')).toHaveLength(0);
  });
});

describe('revokeAllTokens robustness', () => {
  it('leaves nothing usable when a rotation commits mid-sweep', async () => {
    const racing = new RacingStore();
    const conn = await createConnection(racing, input, NOW);
    let next: Awaited<ReturnType<typeof rotateConnection>> | undefined;
    racing.afterQuery = async () => { next = await rotateConnection(racing, conn.refreshToken, 'c1', NOW + 10); };

    await revokeAllTokens(racing);

    if (typeof next !== 'object') throw new Error('the rotation should have won');
    expect(await findToken(racing, next.accessToken, NOW + 11)).toBeUndefined();
    expect(await rotateConnection(racing, next.refreshToken, 'c1', NOW + 12)).toBe('invalid');
    for (const pk of ['AUTH#TOKENS', 'OAUTH#REFRESH', 'OAUTH#REFRESH-USED', 'AUTH#TOKENLIST#u1']) {
      expect(await racing.query(pk)).toHaveLength(0);
    }
  });

  it('clears a user whose access-token lookups have already been purged', async () => {
    const conn = await createConnection(store, input, NOW);
    await store.delete({ PK: 'AUTH#TOKENS', SK: hashToken(conn.accessToken) });

    await revokeAllTokens(store);

    expect(await rotateConnection(store, conn.refreshToken, 'c1', NOW + 1)).toBe('invalid');
    expect(await listTokens(store, 'u1')).toHaveLength(0);
    expect(await store.query('OAUTH#REFRESH')).toHaveLength(0);
  });
});
