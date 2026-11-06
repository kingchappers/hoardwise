import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SqliteStore } from '../../store/sqlite';
import { resetTestStore, seedUser, useTestStore } from '../../store/testing';
import { getCategories, createCategory, deleteCategory, updateCategory } from '../categories';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

let store: SqliteStore;
beforeEach(() => { store = useTestStore(); });
afterEach(() => { resetTestStore(); });

async function nothingStored(userId = 'user-1'): Promise<void> {
  expect(await store.query(`USER#${userId}`)).toEqual([]);
}

function makeEvent(body?: object, params?: Record<string, string>): APIGatewayProxyEventV2 {
  return {
    body: body ? JSON.stringify(body) : undefined,
    pathParameters: params,
    queryStringParameters: {},
    requestContext: { http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

describe('getCategories', () => {

  it('returns default categories plus user custom categories', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'CAT#custom-1', categoryId: 'custom-1', name: 'My Cat', type: 'EXPENSE', icon: 'star', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const res = await getCategories(makeEvent(), 'user-1', {});
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.categories.some((c: any) => c.categoryId === 'cat-mortgage')).toBe(true);
    expect(body.categories.some((c: any) => c.categoryId === 'custom-1')).toBe(true);
  });

  it('falls back to a default icon instead of the string "undefined" for a legacy custom item with no icon', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'CAT#custom-1', categoryId: 'custom-1', name: 'My Cat', type: 'EXPENSE', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const res = await getCategories(makeEvent(), 'user-1', {});
    const custom = JSON.parse(res.body).categories.find((c: any) => c.categoryId === 'custom-1');
    expect(custom.icon).toBe('default');
  });

  it('marks archived pots, built-in and custom, and leaves the rest unmarked', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'CAT#custom-pot', categoryId: 'custom-pot', name: 'Garden', type: 'POT', icon: 'star', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' },
      { SK: 'CAT#custom-live', categoryId: 'custom-live', name: 'Car', type: 'POT', icon: 'star', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' },
      { SK: 'POT#custom-pot', categoryId: 'custom-pot', archivedAt: '2026-10-01T00:00:00.000Z' },
      { SK: 'POT#cat-holidays', categoryId: 'cat-holidays', archivedAt: '2026-10-02T00:00:00.000Z' },
      { SK: 'POT#custom-live', categoryId: 'custom-live', archivedAt: null },
    ]);
    const res = await getCategories(makeEvent(), 'user-1', {});
    const byId = new Map<string, any>(JSON.parse(res.body).categories.map((c: any) => [c.categoryId, c]));
    expect(byId.get('custom-pot').archived).toBe(true);
    expect(byId.get('cat-holidays').archived).toBe(true);
    expect(byId.get('custom-live').archived).toBeUndefined();
    expect(byId.get('cat-gifts').archived).toBeUndefined();
  });
});

describe('createCategory', () => {

  it('creates a category and returns 201', async () => {
    const res = await createCategory(
      makeEvent({ name: 'My Custom Cat', type: 'EXPENSE', icon: 'star' }),
      'user-1',
      {},
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.category.name).toBe('My Custom Cat');
    expect(body.category.isDefault).toBe(false);
    expect(await store.get({ PK: 'USER#user-1', SK: `CAT#${body.category.categoryId}` })).toMatchObject({ name: 'My Custom Cat', type: 'EXPENSE' });
  });

  it('returns 400 for missing name', async () => {
    const res = await createCategory(makeEvent({ type: 'EXPENSE' }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    await nothingStored();
  });

  it('returns 400 for invalid type', async () => {
    const res = await createCategory(makeEvent({ name: 'X', type: 'INVALID' }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    await nothingStored();
  });

  it('returns 400 for name over 50 chars', async () => {
    const res = await createCategory(
      makeEvent({ name: 'a'.repeat(51), type: 'EXPENSE' }),
      'user-1',
      {},
    );
    expect(res.statusCode).toBe(400);
  });

  it('accepts a name that is only over 50 chars before trimming', async () => {
    const res = await createCategory(
      makeEvent({ name: `  ${'a'.repeat(50)}  `, type: 'EXPENSE' }),
      'user-1',
      {},
    );
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).category.name).toBe('a'.repeat(50));
  });

  it('stores a valid group', async () => {
    const res = await createCategory(makeEvent({ name: 'Joint Account', type: 'EXPENSE', group: 'BILLS' }), 'user-1', {});
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).category.group).toBe('BILLS');
    expect(await store.get({ PK: 'USER#user-1', SK: `CAT#${JSON.parse(res.body).category.categoryId}` })).toMatchObject({ group: 'BILLS' });
  });

  it('defaults an EXPENSE category to EVERYDAY', async () => {
    const res = await createCategory(makeEvent({ name: 'Padel', type: 'EXPENSE' }), 'user-1', {});
    expect(JSON.parse(res.body).category.group).toBe('EVERYDAY');
  });

  it('defaults a POT category to SINKING_FUNDS', async () => {
    const res = await createCategory(makeEvent({ name: 'Boiler', type: 'POT' }), 'user-1', {});
    expect(JSON.parse(res.body).category.group).toBe('SINKING_FUNDS');
  });

  it.each([null, '', 5, 'NOPE', 'bills'])('returns 400 for invalid group %j', async (group) => {
    const res = await createCategory(makeEvent({ name: 'X', type: 'EXPENSE', group }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    await nothingStored();
  });

  it('returns 400 when a group is sent for an INCOME category', async () => {
    const res = await createCategory(makeEvent({ name: 'Bonus', type: 'INCOME', group: 'BILLS' }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    await nothingStored();
  });

  it('stores no group for an INCOME category', async () => {
    const res = await createCategory(makeEvent({ name: 'Bonus', type: 'INCOME' }), 'user-1', {});
    expect(JSON.parse(res.body).category.group).toBeUndefined();
  });

  it.each([
    ['EXPENSE', 'SAVING_INVESTMENT'],
    ['EXPENSE', 'SINKING_FUNDS'],
    ['POT', 'BILLS'],
    ['POT', 'EVERYDAY'],
  ])('returns 400 for %s with group %s', async (type, group) => {
    const res = await createCategory(makeEvent({ name: 'X', type, group }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    await nothingStored();
  });

  it.each([
    ['EXPENSE', 'BILLS'],
    ['EXPENSE', 'EVERYDAY'],
    ['POT', 'SINKING_FUNDS'],
    ['POT', 'SAVING_INVESTMENT'],
  ])('returns 201 for %s with group %s', async (type, group) => {
    const res = await createCategory(makeEvent({ name: 'X', type, group }), 'user-1', {});
    expect(res.statusCode).toBe(201);
  });

  it('returns 400 for the removed INVESTMENT type', async () => {
    const res = await createCategory(makeEvent({ name: 'X', type: 'INVESTMENT' }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    await nothingStored();
  });
});

describe('deleteCategory', () => {

  it('deletes a custom category and returns 204, leaving the others', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'CAT#custom-abc', categoryId: 'custom-abc', name: 'Gone', type: 'EXPENSE' },
      { SK: 'CAT#custom-keep', categoryId: 'custom-keep', name: 'Keep', type: 'EXPENSE' },
    ]);
    const res = await deleteCategory(makeEvent(), 'user-1', { categoryId: 'custom-abc' });
    expect(res.statusCode).toBe(204);
    expect(await store.get({ PK: 'USER#user-1', SK: 'CAT#custom-abc' })).toBeUndefined();
    expect(await store.get({ PK: 'USER#user-1', SK: 'CAT#custom-keep' })).toBeDefined();
  });

  it('is a hard delete: nothing goes to the trash', async () => {
    await seedUser(store, 'user-1', [{ SK: 'CAT#custom-abc', categoryId: 'custom-abc', name: 'Gone', type: 'EXPENSE' }]);
    await deleteCategory(makeEvent(), 'user-1', { categoryId: 'custom-abc' });
    expect(await store.query('USER#user-1', { skPrefix: 'TRASH#' })).toHaveLength(0);
  });

  it('returns 204 for a category that does not exist (idempotent delete)', async () => {
    const res = await deleteCategory(makeEvent(), 'user-1', { categoryId: 'custom-gone' });
    expect(res.statusCode).toBe(204);
  });

  it('returns 403 when trying to delete a default category', async () => {
    const res = await deleteCategory(makeEvent(), 'user-1', { categoryId: 'cat-mortgage' });
    expect(res.statusCode).toBe(403);
    await nothingStored();
  });

  it('returns 400 when categoryId is missing', async () => {
    const res = await deleteCategory(makeEvent(), 'user-1', {});
    expect(res.statusCode).toBe(400);
  });
});

describe('updateCategory', () => {

  const existingCategory = {
    categoryId: 'custom-abc', name: 'Old Name', type: 'EXPENSE', icon: 'star',
    group: 'EVERYDAY', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z',
  };

  const seedExisting = (userId = 'user-1'): Promise<void> =>
    seedUser(store, userId, [{ SK: 'CAT#custom-abc', ...existingCategory }]);

  it('renames a custom category and returns 200, preserving other fields', async () => {
    await seedExisting();
    const res = await updateCategory(makeEvent({ name: 'New Name' }), 'user-1', { categoryId: 'custom-abc' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).category).toEqual({ ...existingCategory, name: 'New Name' });
    expect(await store.get({ PK: 'USER#user-1', SK: 'CAT#custom-abc' })).toMatchObject({ ...existingCategory, name: 'New Name' });
  });

  it('renames in place, keeping the other attributes', async () => {
    await seedUser(store, 'user-1', [{ SK: 'CAT#c1', categoryId: 'c1', name: 'Old', type: 'EXPENSE', icon: 'star', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' }]);
    const res = await updateCategory(makeEvent({ name: 'New' }), 'user-1', { categoryId: 'c1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).category).toMatchObject({ categoryId: 'c1', name: 'New', icon: 'star' });
  });

  it('trims the new name', async () => {
    await seedExisting();
    const res = await updateCategory(makeEvent({ name: '  Padel  ' }), 'user-1', { categoryId: 'custom-abc' });
    expect(JSON.parse(res.body).category.name).toBe('Padel');
    expect(await store.get({ PK: 'USER#user-1', SK: 'CAT#custom-abc' })).toMatchObject({ name: 'Padel' });
  });

  it('accepts a name that is only over 50 chars before trimming', async () => {
    await seedExisting();
    const res = await updateCategory(makeEvent({ name: `  ${'a'.repeat(50)}  ` }), 'user-1', { categoryId: 'custom-abc' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for a category that does not exist for this user, creating nothing', async () => {
    const res = await updateCategory(makeEvent({ name: 'New Name' }), 'user-1', { categoryId: 'unknown-id' });
    expect(res.statusCode).toBe(404);
    await nothingStored();
  });

  it('returns 404 for an unknown category even when the body is invalid', async () => {
    const res = await updateCategory(makeEvent({}), 'user-1', { categoryId: 'unknown-id' });
    expect(res.statusCode).toBe(404);
    await nothingStored();
  });

  it('builds the key from the caller, so another user\'s category is not found for them', async () => {
    await seedExisting('user-1');
    const res = await updateCategory(makeEvent({ name: 'New Name' }), 'user-2', { categoryId: 'custom-abc' });
    expect(res.statusCode).toBe(404);
    await nothingStored('user-2');
    expect(await store.get({ PK: 'USER#user-1', SK: 'CAT#custom-abc' })).toMatchObject({ name: 'Old Name' });
  });

  it('returns 403 when trying to rename a default category', async () => {
    const res = await updateCategory(makeEvent({ name: 'New Name' }), 'user-1', { categoryId: 'cat-mortgage' });
    expect(res.statusCode).toBe(403);
    await nothingStored();
  });

  it('returns 400 when categoryId is missing', async () => {
    const res = await updateCategory(makeEvent({ name: 'New Name' }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    await nothingStored();
  });

  it('returns 400 for missing name', async () => {
    await seedExisting();
    const res = await updateCategory(makeEvent({}), 'user-1', { categoryId: 'custom-abc' });
    expect(res.statusCode).toBe(400);
    expect(await store.get({ PK: 'USER#user-1', SK: 'CAT#custom-abc' })).toMatchObject({ name: 'Old Name' });
  });

  it('returns 400 for an empty name', async () => {
    await seedExisting();
    const res = await updateCategory(makeEvent({ name: '   ' }), 'user-1', { categoryId: 'custom-abc' });
    expect(res.statusCode).toBe(400);
    expect(await store.get({ PK: 'USER#user-1', SK: 'CAT#custom-abc' })).toMatchObject({ name: 'Old Name' });
  });

  it('returns 400 for name over 50 chars', async () => {
    await seedExisting();
    const res = await updateCategory(makeEvent({ name: 'a'.repeat(51) }), 'user-1', { categoryId: 'custom-abc' });
    expect(res.statusCode).toBe(400);
    expect(await store.get({ PK: 'USER#user-1', SK: 'CAT#custom-abc' })).toMatchObject({ name: 'Old Name' });
  });

  it('rethrows unexpected errors', async () => {
    await seedExisting();
    vi.spyOn(store, 'patch').mockRejectedValueOnce(new Error('boom'));
    await expect(updateCategory(makeEvent({ name: 'New Name' }), 'user-1', { categoryId: 'custom-abc' })).rejects.toThrow('boom');
  });

  it('falls back to a default icon instead of the string "undefined" for a legacy item with no icon', async () => {
    const { icon: _icon, ...noIcon } = existingCategory;
    await seedUser(store, 'user-1', [{ SK: 'CAT#custom-abc', ...noIcon }]);
    const res = await updateCategory(makeEvent({ name: 'New Name' }), 'user-1', { categoryId: 'custom-abc' });
    expect(JSON.parse(res.body).category.icon).toBe('default');
  });
});
