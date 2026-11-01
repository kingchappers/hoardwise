import { beforeEach, describe, expect, it } from 'vitest';
import { ConditionFailedError } from '../../store';
import { MemoryStore } from '../../store/memory';
import { hashToken } from '../localData';
import {
  MAX_TOKENS_PER_USER, TOKEN_PATTERN, TokenLimitError, createToken, findToken, listTokens, revokeAllTokens, revokeToken, touchToken,
} from '../tokens';

let store: MemoryStore;
const NOW = 1_800_000_000;
const DAY = 24 * 60 * 60;

function input(overrides: Partial<Parameters<typeof createToken>[1]> = {}): Parameters<typeof createToken>[1] {
  return { userId: 'u1', name: 'My tool', scope: 'read', expiryDays: 90, ...overrides };
}

beforeEach(() => { store = new MemoryStore(); });

describe('createToken', () => {
  it('makes a read token that starts hwr_ and is 47 characters', async () => {
    const read = await createToken(store, input(), NOW);
    const write = await createToken(store, input({ scope: 'write' }), NOW);
    expect(read.token.startsWith('hwr_')).toBe(true);
    expect(read.token).toHaveLength(47);
    expect(write.token.startsWith('hww_')).toBe(true);
    expect(read.token).toMatch(TOKEN_PATTERN);
    expect(write.token).toMatch(TOKEN_PATTERN);
    expect(read.token).not.toBe(write.token);
    expect(read.record.prefix).toBe(read.token.slice(0, 8));
  });

  it('stores only a hash: the token appears nowhere in the store', async () => {
    const { token } = await createToken(store, input(), NOW);
    const rows = [...await store.query('AUTH#TOKENS'), ...await store.query('AUTH#TOKENLIST#u1')];
    expect(rows.length).toBe(2);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('sets expiresAt to now plus the chosen days, and null for never', async () => {
    const dated = await createToken(store, input({ expiryDays: 180 }), NOW);
    const never = await createToken(store, input({ expiryDays: null }), NOW);
    expect(dated.record.expiresAt).toBe(NOW + 180 * DAY);
    expect(never.record.expiresAt).toBeNull();
  });

  it('refuses a 26th token with TokenLimitError and allows one after a revoke', async () => {
    let first = '';
    for (let i = 0; i < MAX_TOKENS_PER_USER; i++) {
      const { record } = await createToken(store, input({ name: `t${i}` }), NOW + i);
      if (i === 0) first = record.tokenId;
    }
    await expect(createToken(store, input(), NOW + 100)).rejects.toBeInstanceOf(TokenLimitError);
    await revokeToken(store, 'u1', first);
    await expect(createToken(store, input(), NOW + 101)).resolves.toBeDefined();
  });
});

describe('findToken', () => {
  it('finds a token and returns the stored scope, ignoring the prefix', async () => {
    const token = `hww_${'a'.repeat(43)}`;
    await store.put({
      PK: 'AUTH#TOKENS', SK: hashToken(token), tokenId: 't1', userId: 'u1', name: 'n', scope: 'read',
      createdAt: NOW, expiresAt: null, lastUsedAt: null, prefix: 'hww_aaaa',
    });
    const found = await findToken(store, token, NOW);
    expect(found?.scope).toBe('read');
    expect(found?.userId).toBe('u1');
  });

  it('does not find a token at its exact expiry second, but does one second earlier', async () => {
    const { token, record } = await createToken(store, input(), NOW);
    expect(await findToken(store, token, record.expiresAt! - 1)).toBeDefined();
    expect(await findToken(store, token, record.expiresAt!)).toBeUndefined();
  });

  it('finds a never-expiring token ten years later', async () => {
    const { token } = await createToken(store, input({ expiryDays: null }), NOW);
    expect(await findToken(store, token, NOW + 3650 * DAY)).toBeDefined();
  });

  it('does not find an unknown token', async () => {
    expect(await findToken(store, `hwr_${'b'.repeat(43)}`, NOW)).toBeUndefined();
  });
});

describe('listTokens', () => {
  it("lists only the owner's tokens, newest first, without hash or secret", async () => {
    const { token: oldToken } = await createToken(store, input({ name: 'old' }), NOW);
    await createToken(store, input({ name: 'new' }), NOW + 10);
    await createToken(store, input({ userId: 'u2', name: 'other' }), NOW + 5);
    const list = await listTokens(store, 'u1');
    expect(list.map((t) => t.name)).toEqual(['new', 'old']);
    const serialised = JSON.stringify(list);
    expect(serialised).not.toContain('hash');
    expect(serialised).not.toContain(oldToken);
    expect(serialised).not.toContain(hashToken(oldToken));
  });
});

describe('revoking', () => {
  it("revokes the lookup and the listing together; another user's tokenId returns false and removes nothing", async () => {
    const { token, record } = await createToken(store, input(), NOW);
    expect(await revokeToken(store, 'u2', record.tokenId)).toBe(false);
    expect(await findToken(store, token, NOW)).toBeDefined();
    expect(await listTokens(store, 'u1')).toHaveLength(1);

    expect(await revokeToken(store, 'u1', record.tokenId)).toBe(true);
    expect(await findToken(store, token, NOW)).toBeUndefined();
    expect(await listTokens(store, 'u1')).toHaveLength(0);
    expect(await store.query('AUTH#TOKENS')).toHaveLength(0);
  });

  it('revokeAllTokens removes every token of every user', async () => {
    const a = await createToken(store, input(), NOW);
    const b = await createToken(store, input({ userId: 'u2' }), NOW);
    await revokeAllTokens(store);
    expect(await findToken(store, a.token, NOW)).toBeUndefined();
    expect(await findToken(store, b.token, NOW)).toBeUndefined();
    expect(await listTokens(store, 'u1')).toHaveLength(0);
    expect(await listTokens(store, 'u2')).toHaveLength(0);
  });
});

describe('touchToken', () => {
  it('writes lastUsedAt at most once an hour', async () => {
    const { token } = await createToken(store, input(), NOW);
    const lastUsed = async (): Promise<number | null> => (await listTokens(store, 'u1'))[0].lastUsedAt;

    await touchToken(store, (await findToken(store, token, NOW + 10))!, NOW + 10);
    expect(await lastUsed()).toBe(NOW + 10);

    await touchToken(store, (await findToken(store, token, NOW + 20))!, NOW + 20);
    expect(await lastUsed()).toBe(NOW + 10);

    await touchToken(store, (await findToken(store, token, NOW + 3611))!, NOW + 3611);
    expect(await lastUsed()).toBe(NOW + 3611);
  });

  it('touchToken after a revoke does not bring the token back', async () => {
    const { token, record } = await createToken(store, input(), NOW);
    const stored = (await findToken(store, token, NOW))!;
    await revokeToken(store, 'u1', record.tokenId);
    try {
      await touchToken(store, stored, NOW + 10);
    } catch (error) {
      if (!(error instanceof ConditionFailedError)) throw error;
    }
    expect(await findToken(store, token, NOW + 10)).toBeUndefined();
    expect(await listTokens(store, 'u1')).toHaveLength(0);
  });
});

describe('oauth kind', () => {
  it('leaves kind off a personal token and exposes it on an oauth listing row', async () => {
    const { token } = await createToken(store, input(), NOW);
    expect((await listTokens(store, 'u1'))[0].kind).toBeUndefined();
    expect((await findToken(store, token, NOW))?.kind).toBeUndefined();

    await store.put({ PK: 'AUTH#TOKENLIST#u1', SK: 'oauth-1', tokenId: 'oauth-1', name: 'Claude', scope: 'read', createdAt: NOW, expiresAt: NOW + 5, lastUsedAt: null, prefix: 'hwr_abcd', hash: 'h', kind: 'oauth' });
    const listed = await listTokens(store, 'u1');
    expect(listed.find((t) => t.tokenId === 'oauth-1')?.kind).toBe('oauth');
  });

  it('revokeToken also deletes the refresh row named by refreshHash', async () => {
    await store.put({ PK: 'AUTH#TOKENLIST#u1', SK: 'oauth-1', tokenId: 'oauth-1', name: 'Claude', scope: 'read', createdAt: NOW, expiresAt: NOW + 5, lastUsedAt: null, prefix: 'hwr_abcd', hash: 'h', kind: 'oauth', refreshHash: 'rh' });
    await store.put({ PK: 'OAUTH#REFRESH', SK: 'rh', userId: 'u1' });
    await revokeToken(store, 'u1', 'oauth-1');
    expect(await store.get({ PK: 'OAUTH#REFRESH', SK: 'rh' })).toBeUndefined();
  });
});
