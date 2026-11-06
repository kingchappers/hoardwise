import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SqliteStore } from '../../store/sqlite';
import { resetTestStore, seedUser, useTestStore } from '../../store/testing';
import { reassignCategory } from '../reassign';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

let store: SqliteStore;
beforeEach(async () => {
  store = useTestStore();
  await seedUser(store, 'user-1', [{ SK: 'CAT#cat-custom', categoryId: 'cat-custom', name: 'Custom', type: 'EXPENSE' }]);
});
afterEach(() => { resetTestStore(); });

function makeEvent(body?: object): APIGatewayProxyEventV2 {
  return {
    body: body ? JSON.stringify(body) : undefined,
    requestContext: { http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}

async function categoryOf(sk: string, userId = 'user-1'): Promise<unknown> {
  const item = await store.get({ PK: `USER#${userId}`, SK: sk });
  return item?.categoryId;
}

describe('reassignCategory', () => {
  it('reassigns every matching transaction across months and leaves other categories alone', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'TXN#2026-06#a', categoryId: 'cat-custom' },
      { SK: 'TXN#2026-07#b', categoryId: 'cat-custom' },
      { SK: 'TXN#2026-07#c', categoryId: 'cat-food' },
    ]);

    const res = await reassignCategory(makeEvent({ toCategoryId: 'cat-going-out' }), 'user-1', { categoryId: 'cat-custom' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reassigned: 2, recurringReassigned: 0 });
    expect(await categoryOf('TXN#2026-06#a')).toBe('cat-going-out');
    expect(await categoryOf('TXN#2026-07#b')).toBe('cat-going-out');
    expect(await categoryOf('TXN#2026-07#c')).toBe('cat-food');
  });

  it('returns 200 with zero when nothing matches', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-07#c', categoryId: 'cat-food' }]);
    const res = await reassignCategory(makeEvent({ toCategoryId: 'cat-going-out' }), 'user-1', { categoryId: 'cat-custom' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).reassigned).toBe(0);
    expect(await categoryOf('TXN#2026-07#c')).toBe('cat-food');
  });

  it('returns 404 for an unknown source category even when the body is invalid', async () => {
    const res = await reassignCategory(makeEvent({}), 'user-1', { categoryId: 'cat-missing' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an unknown source category and changes nothing', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-07#c', categoryId: 'cat-missing' }]);
    const res = await reassignCategory(makeEvent({ toCategoryId: 'cat-going-out' }), 'user-1', { categoryId: 'cat-missing' });
    expect(res.statusCode).toBe(404);
    expect(await categoryOf('TXN#2026-07#c')).toBe('cat-missing');
  });

  it('rejects reassigning a category to itself without touching the store', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-07#a', categoryId: 'cat-custom' }]);
    const querySpy = vi.spyOn(store, 'query');
    const patchSpy = vi.spyOn(store, 'patch');
    const res = await reassignCategory(makeEvent({ toCategoryId: 'cat-custom' }), 'user-1', { categoryId: 'cat-custom' });
    expect(res.statusCode).toBe(400);
    expect(querySpy).not.toHaveBeenCalled();
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing toCategoryId', async () => {
    const res = await reassignCategory(makeEvent({}), 'user-1', { categoryId: 'cat-custom' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown target category and changes nothing', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-07#a', categoryId: 'cat-custom' }]);
    const res = await reassignCategory(makeEvent({ toCategoryId: 'cat-nonexistent' }), 'user-1', { categoryId: 'cat-custom' });
    expect(res.statusCode).toBe(400);
    expect(await categoryOf('TXN#2026-07#a')).toBe('cat-custom');
  });

  it('rejects a target category that only exists for another user', async () => {
    await seedUser(store, 'user-2', [{ SK: 'CAT#cat-side-hustle', categoryId: 'cat-side-hustle', name: 'Side', type: 'EXPENSE' }]);
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-07#a', categoryId: 'cat-custom' }]);
    const res = await reassignCategory(makeEvent({ toCategoryId: 'cat-side-hustle' }), 'user-1', { categoryId: 'cat-custom' });
    expect(res.statusCode).toBe(400);
    expect(await categoryOf('TXN#2026-07#a')).toBe('cat-custom');
  });

  it('reassigns to a non-default category that exists', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'CAT#cat-side-hustle', categoryId: 'cat-side-hustle', name: 'Side', type: 'EXPENSE' },
      { SK: 'TXN#2026-07#a', categoryId: 'cat-custom' },
    ]);

    const res = await reassignCategory(makeEvent({ toCategoryId: 'cat-side-hustle' }), 'user-1', { categoryId: 'cat-custom' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).reassigned).toBe(1);
    expect(await categoryOf('TXN#2026-07#a')).toBe('cat-side-hustle');
  });

  it('skips an item deleted between the read and the update, and counts only the ones it changed', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'TXN#2026-10#a', categoryId: 'old' },
      { SK: 'TXN#2026-10#b', categoryId: 'old' },
      { SK: 'CAT#old', categoryId: 'old', name: 'Old', type: 'EXPENSE' },
      { SK: 'CAT#new', categoryId: 'new', name: 'New', type: 'EXPENSE' },
    ]);
    const realPatch = store.patch.bind(store);
    vi.spyOn(store, 'patch').mockImplementation(async (key, fields, opts) => {
      if (key.SK === 'TXN#2026-10#b') await store.delete(key);
      return realPatch(key, fields, opts);
    });
    const res = await reassignCategory(makeEvent({ toCategoryId: 'new' }), 'user-1', { categoryId: 'old' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reassigned: 1, recurringReassigned: 0 });
    expect(await categoryOf('TXN#2026-10#a')).toBe('new');
    expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-10#b' })).toBeUndefined();
  });

  it('rethrows an unexpected failure while updating an item', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-07#a', categoryId: 'cat-custom' }]);
    vi.spyOn(store, 'patch').mockRejectedValueOnce(new Error('boom'));
    await expect(
      reassignCategory(makeEvent({ toCategoryId: 'cat-going-out' }), 'user-1', { categoryId: 'cat-custom' }),
    ).rejects.toThrow('boom');
  });

  it('also moves recurring templates that use the category', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'TXN#2026-07#a', categoryId: 'cat-custom' },
      { SK: 'RECUR#r1', categoryId: 'cat-custom' },
      { SK: 'RECUR#r2', categoryId: 'cat-food' },
    ]);

    const res = await reassignCategory(makeEvent({ toCategoryId: 'cat-going-out' }), 'user-1', { categoryId: 'cat-custom' });

    expect(JSON.parse(res.body)).toEqual({ reassigned: 1, recurringReassigned: 1 });
    expect(await categoryOf('TXN#2026-07#a')).toBe('cat-going-out');
    expect(await categoryOf('RECUR#r1')).toBe('cat-going-out');
    expect(await categoryOf('RECUR#r2')).toBe('cat-food');
  });

  it('only touches the caller\'s items', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'RECUR#r1', categoryId: 'cat-custom' },
      { SK: 'RECUR#r2', categoryId: 'cat-custom' },
    ]);
    await seedUser(store, 'user-2', [
      { SK: 'TXN#2026-07#x', categoryId: 'cat-custom' },
      { SK: 'RECUR#r1', categoryId: 'cat-custom' },
    ]);

    const res = await reassignCategory(makeEvent({ toCategoryId: 'cat-going-out' }), 'user-1', { categoryId: 'cat-custom' });

    expect(JSON.parse(res.body).recurringReassigned).toBe(2);
    expect(await categoryOf('RECUR#r1', 'user-1')).toBe('cat-going-out');
    expect(await categoryOf('TXN#2026-07#x', 'user-2')).toBe('cat-custom');
    expect(await categoryOf('RECUR#r1', 'user-2')).toBe('cat-custom');
  });
});
