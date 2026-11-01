import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory';
import { ClientLimitError, InvalidRedirectError, getClient, registerClient, touchClient } from '../clients';
import { MAX_CLIENTS } from '../types';

let store: MemoryStore;
const NOW = 1_800_000_000;
const DAY = 86400;

beforeEach(() => { store = new MemoryStore(); });

describe('registerClient', () => {
  it('registers a client with a random 128-bit base64url id', async () => {
    const client = await registerClient(store, { name: 'Claude', redirectUris: ['https://claude.ai/cb'] }, NOW);
    expect(client.clientId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(client).toMatchObject({ name: 'Claude', redirectUris: ['https://claude.ai/cb'], createdAt: NOW });
    expect(await getClient(store, client.clientId, NOW)).toEqual(client);
  });

  it.each([
    'http://example.com/cb',
    'https://claude.ai/cb#frag',
    'https://user:pw@claude.ai/cb',
    'ftp://claude.ai/cb',
    'not a url',
    `https://claude.ai/${'a'.repeat(2000)}`,
  ])('rejects %s', async (uri) => {
    await expect(registerClient(store, { name: 'x', redirectUris: [uri] }, NOW)).rejects.toBeInstanceOf(InvalidRedirectError);
  });

  it.each(['http://127.0.0.1:8080/cb', 'http://[::1]:8080/cb', 'http://localhost:3000/cb'])('accepts loopback %s', async (uri) => {
    await expect(registerClient(store, { name: 'x', redirectUris: [uri] }, NOW)).resolves.toBeDefined();
  });

  it('rejects no redirect URIs and more than five', async () => {
    await expect(registerClient(store, { name: 'x', redirectUris: [] }, NOW)).rejects.toBeInstanceOf(InvalidRedirectError);
    const six = Array.from({ length: 6 }, (_, i) => `https://claude.ai/${i}`);
    await expect(registerClient(store, { name: 'x', redirectUris: six }, NOW)).rejects.toBeInstanceOf(InvalidRedirectError);
  });

  async function fill(): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < MAX_CLIENTS; i++) {
      ids.push((await registerClient(store, { name: `c${i}`, redirectUris: ['https://claude.ai/cb'] }, NOW + i)).clientId);
    }
    return ids;
  }

  it('evicts the oldest unused client for the 501st registration', async () => {
    const ids = await fill();
    const added = await registerClient(store, { name: 'one more', redirectUris: ['https://claude.ai/cb'] }, NOW + MAX_CLIENTS);
    expect(await getClient(store, ids[0], NOW + MAX_CLIENTS)).toBeUndefined();
    expect(await getClient(store, ids[1], NOW + MAX_CLIENTS)).toBeDefined();
    expect(await getClient(store, added.clientId, NOW + MAX_CLIENTS)).toBeDefined();
  });

  it('never evicts a client that has been used', async () => {
    const ids = await fill();
    await touchClient(store, ids[0], NOW + MAX_CLIENTS);
    await registerClient(store, { name: 'one more', redirectUris: ['https://claude.ai/cb'] }, NOW + MAX_CLIENTS);
    expect(await getClient(store, ids[0], NOW + MAX_CLIENTS)).toBeDefined();
    expect(await getClient(store, ids[1], NOW + MAX_CLIENTS)).toBeUndefined();
  });

  it('throws ClientLimitError at the cap when every client is in use', async () => {
    for (const id of await fill()) await touchClient(store, id, NOW + MAX_CLIENTS);
    await expect(registerClient(store, { name: 'one more', redirectUris: ['https://claude.ai/cb'] }, NOW + MAX_CLIENTS))
      .rejects.toBeInstanceOf(ClientLimitError);
  });

  it('does not count expired clients toward the cap', async () => {
    for (let i = 0; i < MAX_CLIENTS; i++) {
      await registerClient(store, { name: `c${i}`, redirectUris: ['https://claude.ai/cb'] }, NOW);
    }
    await expect(registerClient(store, { name: 'later', redirectUris: ['https://claude.ai/cb'] }, NOW + 2 * DAY)).resolves.toBeDefined();
  });

  it('trims and truncates the name to 60 characters', async () => {
    const client = await registerClient(store, { name: `  ${'n'.repeat(80)}  `, redirectUris: ['https://claude.ai/cb'] }, NOW);
    expect(client.name).toBe('n'.repeat(60));
  });
});

describe('getClient and touchClient', () => {
  it('reads an unused client as absent after 24 hours but present just before', async () => {
    const { clientId } = await registerClient(store, { name: 'x', redirectUris: ['https://claude.ai/cb'] }, NOW);
    expect(await getClient(store, clientId, NOW + DAY - 1)).toBeDefined();
    expect(await getClient(store, clientId, NOW + DAY)).toBeUndefined();
  });

  it('keeps a used client for 90 days', async () => {
    const { clientId } = await registerClient(store, { name: 'x', redirectUris: ['https://claude.ai/cb'] }, NOW);
    await touchClient(store, clientId, NOW + DAY - 1);
    expect(await getClient(store, clientId, NOW + 60 * DAY)).toBeDefined();
    expect(await getClient(store, clientId, NOW + DAY - 1 + 90 * DAY)).toBeUndefined();
  });

  it('returns undefined for an unknown client and touch does not create one', async () => {
    expect(await getClient(store, 'nope', NOW)).toBeUndefined();
    await touchClient(store, 'nope', NOW);
    expect(await getClient(store, 'nope', NOW)).toBeUndefined();
  });
});
