import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../../auth/localData';
import { MemoryStore } from '../../store/memory';
import { consumeCode, issueCode } from '../codes';

let store: MemoryStore;
const NOW = 1_800_000_000;
const input = { clientId: 'c1', userId: 'u1', scope: 'read' as const, redirectUri: 'https://claude.ai/cb', codeChallenge: 'chal' };

beforeEach(() => { store = new MemoryStore(); });

describe('codes', () => {
  it('issues a 256-bit base64url code stored only as its hash', async () => {
    const code = await issueCode(store, input, NOW);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await store.query('OAUTH#CODES');
    expect(rows).toHaveLength(1);
    expect(rows[0].SK).toBe(hashToken(code));
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(rows[0].expiresAt).toBe(NOW + 60);
  });

  it('returns the record once and undefined the second time', async () => {
    const code = await issueCode(store, input, NOW);
    expect(await consumeCode(store, code, NOW + 1)).toMatchObject(input);
    expect(await consumeCode(store, code, NOW + 2)).toBeUndefined();
  });

  it('returns undefined after 61 seconds and for an unknown code', async () => {
    const code = await issueCode(store, input, NOW);
    expect(await consumeCode(store, code, NOW + 61)).toBeUndefined();
    expect(await consumeCode(store, 'unknown', NOW)).toBeUndefined();
  });

  it('lets exactly one of two concurrent exchanges win', async () => {
    const code = await issueCode(store, input, NOW);
    const results = await Promise.all([consumeCode(store, code, NOW + 1), consumeCode(store, code, NOW + 1)]);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });
});
