import { describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '../sqlite';
import { exportUser, importUser, parseJsonl, toJsonl } from '../transfer';

const seed = async (store: SqliteStore): Promise<void> => {
  await store.put({ PK: 'USER#auth0|abc', SK: 'CAT#c1', name: 'Garden', archivedAt: null });
  await store.put({ PK: 'USER#auth0|abc', SK: 'TXN#2026-10#t1', amount: 350 });
  await store.put({ PK: 'USER#auth0|abc', SK: 'TRASH#TARGET#c1', expiresAt: 4102444800 });
  await store.put({ PK: 'USER#auth0|abc', SK: 'PUSHSUB#hash', endpoint: 'https://fcm.googleapis.com/x' });
  await store.put({ PK: 'PUSHIDX', SK: 'USER#auth0|abc', updatedAt: 'x' });
  await store.put({ PK: 'USER#someone-else', SK: 'CAT#other', name: 'Other' });
};

describe('exportUser', () => {
  it('exports one partition, keeping trash and leaving out push subscriptions', async () => {
    const store = new SqliteStore(':memory:');
    await seed(store);
    const items = await exportUser(store, 'auth0|abc');
    expect(items.map(item => item.SK)).toEqual(['CAT#c1', 'TRASH#TARGET#c1', 'TXN#2026-10#t1']);
  });
});

describe('saved styles', () => {
  const styleRows = [
    { PK: 'USER#auth0|abc', SK: 'STYLE#s1', styleId: 's1', name: 'Big number', description: 'One figure' },
    { PK: 'USER#auth0|abc', SK: 'STYLENAME#big number', styleId: 's1' },
    { PK: 'USER#auth0|abc', SK: 'STYLEDEFAULT', styleId: 's1' },
  ];

  it('exports and re-imports styles and the default marker', async () => {
    const source = new SqliteStore(':memory:');
    await seed(source);
    for (const row of styleRows) await source.put(row);
    const items = await exportUser(source, 'auth0|abc');
    expect(items.map(item => item.SK)).toEqual(expect.arrayContaining(['STYLE#s1', 'STYLENAME#big number', 'STYLEDEFAULT']));

    const target = new SqliteStore(':memory:');
    await importUser(target, items, { asUser: 'new' });
    expect((await target.query('USER#new')).map(item => item.SK)).toEqual(expect.arrayContaining(['STYLE#s1', 'STYLENAME#big number', 'STYLEDEFAULT']));
  });

  it('removes styles that the replaced data did not have, and restores an old export with none', async () => {
    const store = new SqliteStore(':memory:');
    await seed(store);
    const oldExport = await exportUser(store, 'auth0|abc');
    for (const row of styleRows) await store.put(row);

    await importUser(store, oldExport, { asUser: 'auth0|abc', replace: true });
    const sks = (await store.query('USER#auth0|abc')).map(item => item.SK);
    expect(sks).not.toContain('STYLE#s1');
    expect(sks).not.toContain('STYLEDEFAULT');
    expect(sks).not.toContain('STYLENAME#big number');
  });
});

describe('JSONL', () => {
  it('round-trips items, including null and expiry', async () => {
    const store = new SqliteStore(':memory:');
    await seed(store);
    const items = await exportUser(store, 'auth0|abc');
    expect(parseJsonl(toJsonl(items))).toEqual(items);
  });

  it('names the line of a malformed record', () => {
    expect(() => parseJsonl('{"PK":"USER#a","SK":"x"}\nnot json\n')).toThrow('Line 2 is not valid JSON');
    expect(() => parseJsonl('{"PK":"USER#a"}\n')).toThrow('Line 1 is missing PK or SK');
    expect(() => parseJsonl('[1]\n')).toThrow('Line 1 is not an object');
  });

  it('ignores blank lines', () => {
    expect(parseJsonl('\n{"PK":"USER#a","SK":"x"}\n\n')).toHaveLength(1);
  });
});

describe('importUser', () => {
  it('moves the data to the new user id', async () => {
    const source = new SqliteStore(':memory:');
    await seed(source);
    const target = new SqliteStore(':memory:');

    const count = await importUser(target, await exportUser(source, 'auth0|abc'), { asUser: 'local-1' });

    expect(count).toBe(3);
    const copied = await target.query('USER#local-1');
    expect(copied.map(item => item.SK)).toEqual(['CAT#c1', 'TRASH#TARGET#c1', 'TXN#2026-10#t1']);
    expect(copied[0]).toEqual({ PK: 'USER#local-1', SK: 'CAT#c1', name: 'Garden', archivedAt: null });
    expect(copied[1]).toMatchObject({ expiresAt: 4102444800 });
    expect(await target.query('USER#auth0|abc')).toEqual([]);
  });

  it('refuses to write into a user that already has data', async () => {
    const target = new SqliteStore(':memory:');
    await target.put({ PK: 'USER#local-1', SK: 'CAT#existing', name: 'Keep me' });
    await expect(importUser(target, [{ PK: 'USER#a', SK: 'CAT#x' }], { asUser: 'local-1' }))
      .rejects.toThrow('already has data');
    expect(await target.get({ PK: 'USER#local-1', SK: 'CAT#existing' })).toBeDefined();
  });

  it('does not count push subscriptions as existing data', async () => {
    const target = new SqliteStore(':memory:');
    await target.put({ PK: 'USER#local-1', SK: 'PUSHSUB#hash', endpoint: 'https://example.test/x' });
    await importUser(target, [{ PK: 'USER#a', SK: 'CAT#x' }], { asUser: 'local-1' });
    expect(await target.get({ PK: 'USER#local-1', SK: 'PUSHSUB#hash' })).toBeDefined();
  });

  it('leaves existing push subscriptions alone when replacing', async () => {
    const target = new SqliteStore(':memory:');
    await target.put({ PK: 'USER#local-1', SK: 'PUSHSUB#hash', endpoint: 'https://example.test/x' });
    await target.put({ PK: 'USER#local-1', SK: 'CAT#old', name: 'Old' });
    await importUser(target, [{ PK: 'USER#a', SK: 'CAT#new' }], { asUser: 'local-1', replace: true });
    expect((await target.query('USER#local-1')).map(item => item.SK)).toEqual(['CAT#new', 'PUSHSUB#hash']);
  });

  it('replaces the existing data when asked', async () => {
    const target = new SqliteStore(':memory:');
    await target.put({ PK: 'USER#local-1', SK: 'CAT#old', name: 'Old' });
    await importUser(target, [{ PK: 'USER#a', SK: 'CAT#new', name: 'New' }], { asUser: 'local-1', replace: true });
    expect((await target.query('USER#local-1')).map(item => item.SK)).toEqual(['CAT#new']);
  });

  it('rejects a file with more than one partition or a non-user partition', async () => {
    const target = new SqliteStore(':memory:');
    await expect(importUser(target, [{ PK: 'USER#a', SK: 'x' }, { PK: 'USER#b', SK: 'y' }], { asUser: 'z' }))
      .rejects.toThrow('more than one user');
    await expect(importUser(target, [{ PK: 'PUSHIDX', SK: 'USER#a' }], { asUser: 'z' }))
      .rejects.toThrow('USER#');
  });

  it('skips push subscriptions if a hand-edited file contains them', async () => {
    const target = new SqliteStore(':memory:');
    const count = await importUser(
      target,
      [{ PK: 'USER#a', SK: 'CAT#x' }, { PK: 'USER#a', SK: 'PUSHSUB#h', endpoint: 'e' }],
      { asUser: 'z' },
    );
    expect(count).toBe(1);
    expect(await target.query('USER#z', { skPrefix: 'PUSHSUB#' })).toEqual([]);
  });

  it('refuses an empty or push-only file and leaves existing data intact, even with replace', async () => {
    const target = new SqliteStore(':memory:');
    await target.put({ PK: 'USER#local-1', SK: 'CAT#keep', name: 'Keep' });
    const pushOnly = [{ PK: 'USER#a', SK: 'PUSHSUB#h', endpoint: 'e' }];

    await expect(importUser(target, [], { asUser: 'local-1', replace: true })).rejects.toThrow('no importable items');
    await expect(importUser(target, pushOnly, { asUser: 'local-1', replace: true })).rejects.toThrow('no importable items');

    expect((await target.query('USER#local-1')).map(item => item.SK)).toEqual(['CAT#keep']);
  });

  it('keeps the original data when a put fails part-way through a replace', async () => {
    const target = new SqliteStore(':memory:');
    await target.put({ PK: 'USER#local-1', SK: 'CAT#old1', name: 'Old 1' });
    await target.put({ PK: 'USER#local-1', SK: 'CAT#old2', name: 'Old 2' });
    const realPut = target.put.bind(target);
    let calls = 0;
    vi.spyOn(target, 'put').mockImplementation(async item => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return realPut(item);
    });
    const items = [
      { PK: 'USER#a', SK: 'CAT#new1', name: 'New 1' },
      { PK: 'USER#a', SK: 'CAT#new2', name: 'New 2' },
    ];

    await expect(importUser(target, items, { asUser: 'local-1', replace: true })).rejects.toThrow('boom');

    const remaining = (await target.query('USER#local-1')).map(item => item.SK);
    expect(remaining).toEqual(expect.arrayContaining(['CAT#old1', 'CAT#old2']));
  });

  it('ends with exactly the file items on replace, including shared keys', async () => {
    const target = new SqliteStore(':memory:');
    await target.put({ PK: 'USER#local-1', SK: 'CAT#shared', name: 'Old' });
    await target.put({ PK: 'USER#local-1', SK: 'CAT#stale', name: 'Stale' });
    const items = [
      { PK: 'USER#a', SK: 'CAT#shared', name: 'New' },
      { PK: 'USER#a', SK: 'CAT#fresh', name: 'Fresh' },
    ];

    const count = await importUser(target, items, { asUser: 'local-1', replace: true });

    expect(count).toBe(2);
    expect(await target.query('USER#local-1')).toEqual([
      { PK: 'USER#local-1', SK: 'CAT#fresh', name: 'Fresh' },
      { PK: 'USER#local-1', SK: 'CAT#shared', name: 'New' },
    ]);
  });
});
