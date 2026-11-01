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

describe('revoke racing a rotation', () => {
  class RacingStore extends MemoryStore {
    onListingRead: (() => Promise<void>) | undefined;
    override async get(key: { PK: string; SK: string }) {
      const item = await super.get(key);
      if (key.PK.startsWith('AUTH#TOKENLIST#') && this.onListingRead) {
        const hook = this.onListingRead;
        this.onListingRead = undefined;
        await hook();
      }
      return item;
    }
  }

  it('keeps a connection revoked after the rotation read the listing dead', async () => {
    const racing = new RacingStore();
    const conn = await createConnection(racing, input, NOW);
    racing.onListingRead = async () => { await revokeToken(racing, 'u1', conn.tokenId); };

    const result = await rotateConnection(racing, conn.refreshToken, 'c1', NOW + 10);
    expect(['invalid', 'reused']).toContain(result);
    expect(await findToken(racing, conn.accessToken, NOW + 11)).toBeUndefined();
    expect(await listTokens(racing, 'u1')).toHaveLength(0);
    expect(await racing.query('AUTH#TOKENS')).toHaveLength(0);
    expect(await racing.query('OAUTH#REFRESH')).toHaveLength(0);
    expect(await rotateConnection(racing, conn.refreshToken, 'c1', NOW + 12)).toMatch(/^(invalid|reused)$/);
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
