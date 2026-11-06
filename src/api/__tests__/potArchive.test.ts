import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockMoveToTrash } = vi.hoisted(() => ({ mockMoveToTrash: vi.fn() }));

vi.mock('../trash', () => ({ moveToTrash: mockMoveToTrash }));

import { archivePot, unarchivePot } from '../potArchive';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { SqliteStore } from '../../store/sqlite';
import { resetTestStore, seedUser, useTestStore } from '../../store/testing';

let store: SqliteStore;

function event(body: unknown): APIGatewayProxyEventV2 {
  return {
    body: JSON.stringify(body),
    requestContext: { http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}

interface Seed {
  customCategories?: Record<string, unknown>[];
  settings?: Record<string, unknown>[];
  transactions?: Record<string, unknown>[];
  recurring?: Record<string, unknown>[];
}

async function seed(data: Seed): Promise<void> {
  const items = [
    ...(data.customCategories ?? []).map(c => ({ ...c, SK: `CAT#${c.categoryId}` })),
    ...(data.settings ?? []).map(s => ({ ...s, SK: `POT#${s.categoryId}` })),
    ...(data.transactions ?? []).map(t => ({ ...t, SK: `TXN#${t.yearMonth}#${t.transactionId}` })),
    ...(data.recurring ?? []).map(r => ({ ...r, SK: `RECUR#${r.recurringId}` })),
  ];
  await seedUser(store, 'user-1', items);
}

function txn(type: string, amount: number, yearMonth = '2026-10', categoryId = 'cat-garden') {
  return { categoryId, type, amount, yearMonth, transactionId: `${type}-${amount}` };
}

const gardenPot = { categoryId: 'cat-garden', name: 'Garden', type: 'POT', icon: 'tag', isDefault: false };

async function storedPot(categoryId: string): Promise<Record<string, any> | undefined> {
  return store.get({ PK: 'USER#user-1', SK: `POT#${categoryId}` });
}

describe('archivePot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    store = useTestStore();
    mockMoveToTrash.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetTestStore();
  });

  it('archives an empty pot and stamps archivedAt', async () => {
    await seed({ customCategories: [gardenPot], transactions: [txn('SET_ASIDE', 5000), txn('TAKE_OUT', 5000)] });
    const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(200);
    expect(await storedPot('cat-garden')).toMatchObject({
      PK: 'USER#user-1', SK: 'POT#cat-garden', categoryId: 'cat-garden', archivedAt: '2026-10-15T12:00:00.000Z',
    });
  });

  it('refuses with 409 and the balance while the pot still holds money', async () => {
    await seed({ customCategories: [gardenPot], transactions: [txn('SET_ASIDE', 5000), txn('TAKE_OUT', 1500)] });
    const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ balance: 3500 });
    expect(await storedPot('cat-garden')).toBeUndefined();
    expect(mockMoveToTrash).not.toHaveBeenCalled();
  });

  it('reports a pot below zero as a negative balance', async () => {
    await seed({ customCategories: [gardenPot], transactions: [txn('EXPENSE', 2000)] });
    const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).balance).toBe(-2000);
  });

  it('does not count this month\'s auto-contribution, because archiving stops it', async () => {
    await seed({
      customCategories: [gardenPot],
      settings: [{ categoryId: 'cat-garden', monthlyAmount: 5000, goalAmount: null, autoContribute: [{ from: '2026-10', amount: 5000 }], updatedAt: 'u' }],
    });
    const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(200);
    expect((await storedPot('cat-garden'))?.autoContribute).toEqual([]);
  });

  it('keeps earlier auto-contribution history and records the stop from this month', async () => {
    await seed({
      customCategories: [gardenPot],
      transactions: [txn('TAKE_OUT', 5000, '2026-09')],
      settings: [{ categoryId: 'cat-garden', monthlyAmount: 5000, goalAmount: 90000, autoContribute: [{ from: '2026-09', amount: 5000 }], updatedAt: 'u' }],
    });
    const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(200);
    expect(await storedPot('cat-garden')).toMatchObject({
      goalAmount: 90000,
      monthlyAmount: 5000,
      autoContribute: [{ from: '2026-09', amount: 5000 }, { from: '2026-10', amount: 0 }],
    });
  });

  it('moves only this pot\'s recurring items to the trash', async () => {
    await seed({
      customCategories: [gardenPot],
      recurring: [
        { recurringId: 'r1', categoryId: 'cat-garden' },
        { recurringId: 'r2', categoryId: 'cat-other' },
        { recurringId: 'r3', categoryId: 'cat-garden' },
      ],
    });
    const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cancelledRecurring).toBe(2);
    expect(mockMoveToTrash).toHaveBeenCalledTimes(2);
    expect(mockMoveToTrash).toHaveBeenCalledWith('user-1', 'RECURRING', 'RECUR#r1');
    expect(mockMoveToTrash).toHaveBeenCalledWith('user-1', 'RECURRING', 'RECUR#r3');
  });

  it('works for a built-in pot that has no stored category or settings', async () => {
        const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-holidays' });
    expect(res.statusCode).toBe(200);
    expect(await storedPot('cat-holidays')).toMatchObject({ SK: 'POT#cat-holidays', monthlyAmount: null, goalAmount: null });
  });

  it('rejects a category that is not a pot', async () => {
        const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-mortgage' });
    expect(res.statusCode).toBe(400);
    expect(await storedPot('cat-mortgage')).toBeUndefined();
  });

  it('returns 404 for a category that does not exist', async () => {
        const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'nope' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an unknown pot even when the body is invalid', async () => {
    const res = await archivePot(event({}), 'user-1', { categoryId: 'nope' });
    expect(res.statusCode).toBe(404);
  });

  it('accepts the month before and the month after now, but nothing further away', async () => {
    await seed({ customCategories: [gardenPot] });
    for (const month of ['2026-09', '2026-11']) {
      expect((await archivePot(event({ month }), 'user-1', { categoryId: 'cat-garden' })).statusCode).toBe(200);
    }
    for (const month of ['2026-08', '2026-12']) {
      expect((await archivePot(event({ month }), 'user-1', { categoryId: 'cat-garden' })).statusCode).toBe(400);
    }
  });

  it('rejects a missing or malformed month', async () => {
    await seed({ customCategories: [gardenPot] });
    expect((await archivePot(event({}), 'user-1', { categoryId: 'cat-garden' })).statusCode).toBe(400);
    expect((await archivePot(event({ month: '2026-13' }), 'user-1', { categoryId: 'cat-garden' })).statusCode).toBe(400);
    expect((await archivePot(event({ month: '2024-01' }), 'user-1', { categoryId: 'cat-garden' })).statusCode).toBe(400);
  });

  it('rejects unexpected body fields', async () => {
    await seed({ customCategories: [gardenPot] });
    const res = await archivePot(event({ month: '2026-10', archivedAt: 'x' }), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid JSON body', async () => {
    await seed({ customCategories: [gardenPot] });
    const bad = { body: '{nope', requestContext: { http: { method: 'POST' } } } as unknown as APIGatewayProxyEventV2;
    const res = await archivePot(bad, 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(400);
  });

  it('saves nothing when trashing a reminder fails part-way, and a retry finishes the job', async () => {
    await seed({
      customCategories: [gardenPot],
      recurring: [
        { recurringId: 'r1', categoryId: 'cat-garden' },
        { recurringId: 'r2', categoryId: 'cat-garden' },
      ],
    });
    mockMoveToTrash.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('store down'));
    await expect(archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-garden' })).rejects.toThrow('store down');
    expect(await storedPot('cat-garden')).toBeUndefined();

    mockMoveToTrash.mockReset();
    const retry = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-garden' });
    expect(retry.statusCode).toBe(200);
    expect(mockMoveToTrash).toHaveBeenCalledWith('user-1', 'RECURRING', 'RECUR#r2');
    expect(await storedPot('cat-garden')).toMatchObject({ archivedAt: expect.any(String) });
  });

  it('trashes reminders before it saves the archived settings', async () => {
    await seed({ customCategories: [gardenPot], recurring: [{ recurringId: 'r1', categoryId: 'cat-garden' }] });
    mockMoveToTrash.mockImplementation(async () => {
      expect(await storedPot('cat-garden')).toBeUndefined();
    });
    const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(200);
    expect(mockMoveToTrash).toHaveBeenCalledTimes(1);
  });

  it('is safe to run again on an already archived pot', async () => {
    await seed({
      customCategories: [gardenPot],
      settings: [{ categoryId: 'cat-garden', monthlyAmount: null, goalAmount: null, autoContribute: [], archivedAt: '2026-09-01T00:00:00.000Z', updatedAt: 'u' }],
    });
    const res = await archivePot(event({ month: '2026-10' }), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(200);
    expect((await storedPot('cat-garden'))?.archivedAt).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('unarchivePot', () => {
  beforeEach(() => {
    store = useTestStore();
    mockMoveToTrash.mockReset();
  });
  afterEach(() => { resetTestStore(); });

  it('clears archivedAt and keeps the rest of the settings', async () => {
    await seed({
      customCategories: [gardenPot],
      settings: [{ categoryId: 'cat-garden', monthlyAmount: 5000, goalAmount: 90000, autoContribute: [{ from: '2026-09', amount: 0 }], archivedAt: '2026-10-01T00:00:00.000Z', updatedAt: 'u' }],
    });
    const res = await unarchivePot(event({}), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(200);
    expect(await storedPot('cat-garden')).toMatchObject({
      categoryId: 'cat-garden', monthlyAmount: 5000, goalAmount: 90000, archivedAt: null,
      autoContribute: [{ from: '2026-09', amount: 0 }],
    });
  });

  it('refuses a pot with no stored settings and creates nothing', async () => {
    await seed({ customCategories: [gardenPot] });
    const res = await unarchivePot(event({}), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'This pot is not archived' });
    expect(await storedPot('cat-garden')).toBeUndefined();
  });

  it('refuses an active pot and leaves its settings untouched', async () => {
    await seed({
      customCategories: [gardenPot],
      settings: [{ categoryId: 'cat-garden', monthlyAmount: 5000, goalAmount: null, autoContribute: [], archivedAt: null, updatedAt: 'u' }],
    });
    const res = await unarchivePot(event({}), 'user-1', { categoryId: 'cat-garden' });
    expect(res.statusCode).toBe(409);
    expect(await storedPot('cat-garden')).toMatchObject({ updatedAt: 'u', archivedAt: null });
  });

  it('returns archivedAt as null in the response for an archived pot', async () => {
    await seed({
      customCategories: [gardenPot],
      settings: [{ categoryId: 'cat-garden', monthlyAmount: null, goalAmount: null, autoContribute: [], archivedAt: '2026-10-01T00:00:00.000Z', updatedAt: 'u' }],
    });
    const res = await unarchivePot(event({}), 'user-1', { categoryId: 'cat-garden' });
    expect(JSON.parse(res.body).settings.archivedAt).toBeNull();
  });

  it('does not bring cancelled recurring items back', async () => {
    await seed({
      customCategories: [gardenPot],
      settings: [{ categoryId: 'cat-garden', monthlyAmount: null, goalAmount: null, autoContribute: [], archivedAt: '2026-10-01T00:00:00.000Z', updatedAt: 'u' }],
    });
    await unarchivePot(event({}), 'user-1', { categoryId: 'cat-garden' });
    expect(mockMoveToTrash).not.toHaveBeenCalled();
  });

  it('rejects a category that is not a pot', async () => {
        const res = await unarchivePot(event({}), 'user-1', { categoryId: 'cat-mortgage' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a category that does not exist', async () => {
    const res = await unarchivePot(event({}), 'user-1', { categoryId: 'nope' });
    expect(res.statusCode).toBe(404);
  });
});
