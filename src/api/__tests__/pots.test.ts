import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { applyAutoContribute, getPots, putPot, MAX_AUTO_ENTRIES } from '../pots';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { PotAutoEntry } from '../types';
import type { SqliteStore } from '../../store/sqlite';
import { resetTestStore, seedUser, useTestStore } from '../../store/testing';

let store: SqliteStore;

function getEvent(asOf?: string): APIGatewayProxyEventV2 {
  return {
    queryStringParameters: asOf === undefined ? {} : { asOf },
    requestContext: { http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

function putEvent(body: unknown): APIGatewayProxyEventV2 {
  return {
    body: JSON.stringify(body),
    requestContext: { http: { method: 'PUT' } },
  } as unknown as APIGatewayProxyEventV2;
}

function txn(yearMonth: string, type: string, amount: number, categoryId: string) {
  return { SK: `TXN#${yearMonth}#${type}${amount}`, yearMonth, amount, type, categoryId, description: '', date: `${yearMonth}-10`, createdAt: '' };
}

beforeEach(() => {
  store = useTestStore();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  resetTestStore();
});

describe('getPots', () => {
  it.each([undefined, '', '2026-13', '2026-9', 'nope', '2026-11'])('returns 400 for asOf %j', async (asOf) => {
    const spy = vi.spyOn(store, 'query');
    const res = await getPots(getEvent(asOf), 'user-1', {});
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts a past month and the month after the server month', async () => {
    expect((await getPots(getEvent('2024-01'), 'user-1', {})).statusCode).toBe(200);
    expect((await getPots(getEvent('2026-10'), 'user-1', {})).statusCode).toBe(200);
  });

  it('returns only POT categories, defaults and custom, in that order', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'CAT#custom-pot', categoryId: 'custom-pot', name: 'Boiler', type: 'POT', group: 'SINKING_FUNDS', icon: 'tag' },
      { SK: 'CAT#custom-spend', categoryId: 'custom-spend', name: 'Padel', type: 'EXPENSE', group: 'EVERYDAY', icon: 'tag' },
    ]);
    const body = JSON.parse((await getPots(getEvent('2026-09'), 'user-1', {})).body);
    const ids = body.pots.map((p: { categoryId: string }) => p.categoryId);
    expect(ids).toEqual([
      'cat-holidays', 'cat-home-maintenance', 'cat-gifts', 'cat-insurance',
      'cat-emergency-fund', 'cat-investment', 'custom-pot',
    ]);
  });

  it('derives the balance from the transactions and the settings', async () => {
    await seedUser(store, 'user-1', [
      txn('2026-07', 'SET_ASIDE', 10000, 'cat-holidays'),
      txn('2026-08', 'EXPENSE', 2500, 'cat-holidays'),
      txn('2026-08', 'EXPENSE', 999, 'cat-groceries'),
      { SK: 'POT#cat-holidays', categoryId: 'cat-holidays', monthlyAmount: 5000, goalAmount: 200000, autoContribute: [], updatedAt: 't' },
    ]);
    const body = JSON.parse((await getPots(getEvent('2026-08'), 'user-1', {})).body);
    const holidays = body.pots.find((p: { categoryId: string }) => p.categoryId === 'cat-holidays');
    expect(holidays.balance).toBe(7500);
    expect(holidays.monthlyAmount).toBe(5000);
    expect(holidays.goalAmount).toBe(200000);
  });

  it('ignores settings left behind by a category that no longer exists', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'POT#gone', categoryId: 'gone', monthlyAmount: 100, goalAmount: null, autoContribute: [], updatedAt: 't' },
    ]);
    const body = JSON.parse((await getPots(getEvent('2026-09'), 'user-1', {})).body);
    expect(body.pots.some((p: { categoryId: string }) => p.categoryId === 'gone')).toBe(false);
  });

  it('returns a pot that has settings but no transactions', async () => {
    await seedUser(store, 'user-1', [
      { SK: 'POT#cat-gifts', categoryId: 'cat-gifts', monthlyAmount: 2000, goalAmount: null, autoContribute: [], updatedAt: 't' },
    ]);
    const body = JSON.parse((await getPots(getEvent('2026-09'), 'user-1', {})).body);
    const gifts = body.pots.find((p: { categoryId: string }) => p.categoryId === 'cat-gifts');
    expect(gifts).toMatchObject({ balance: 0, monthlyAmount: 2000, months: [] });
  });
});

describe('applyAutoContribute', () => {
  const on: PotAutoEntry[] = [{ from: '2026-06', amount: 5000 }];

  it('adds an entry when turned on', () => {
    expect(applyAutoContribute([], true, 5000, '2026-09')).toEqual([{ from: '2026-09', amount: 5000 }]);
  });

  it('adds nothing when the amount in force already matches', () => {
    expect(applyAutoContribute(on, true, 5000, '2026-09')).toEqual(on);
    expect(applyAutoContribute([], false, null, '2026-09')).toEqual([]);
  });

  it('adds an entry for a changed amount', () => {
    expect(applyAutoContribute(on, true, 7000, '2026-09')).toEqual([...on, { from: '2026-09', amount: 7000 }]);
  });

  it('adds a zero entry when turned off', () => {
    expect(applyAutoContribute(on, false, 5000, '2026-09')).toEqual([...on, { from: '2026-09', amount: 0 }]);
  });

  it('replaces an entry that starts in the saved month', () => {
    const existing: PotAutoEntry[] = [...on, { from: '2026-09', amount: 7000 }];
    expect(applyAutoContribute(existing, true, 8000, '2026-09')).toEqual([...on, { from: '2026-09', amount: 8000 }]);
  });

  it('removes a same-month entry when the saved amount equals the earlier one', () => {
    const existing: PotAutoEntry[] = [...on, { from: '2026-09', amount: 7000 }];
    expect(applyAutoContribute(existing, true, 5000, '2026-09')).toEqual(on);
  });

  it('drops entries that start after the saved month', () => {
    const existing: PotAutoEntry[] = [...on, { from: '2026-11', amount: 9000 }];
    expect(applyAutoContribute(existing, true, 5000, '2026-09')).toEqual(on);
  });
});

describe('putPot', () => {
  const valid = { monthlyAmount: 5000, goalAmount: 300000, autoContribute: false, month: '2026-09' };

  it('accepts amounts of exactly the cap', async () => {
    const res = await putPot(
      putEvent({ ...valid, monthlyAmount: 1_000_000_000, goalAmount: 1_000_000_000 }),
      'user-1',
      { categoryId: 'cat-holidays' },
    );
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['missing monthlyAmount', { ...valid, monthlyAmount: undefined }],
    ['zero monthlyAmount', { ...valid, monthlyAmount: 0 }],
    ['negative goalAmount', { ...valid, goalAmount: -1 }],
    ['fractional goalAmount', { ...valid, goalAmount: 10.5 }],
    ['string monthlyAmount', { ...valid, monthlyAmount: '5000' }],
    ['oversized goalAmount', { ...valid, goalAmount: 1_000_000_001 }],
    ['non-boolean autoContribute', { ...valid, autoContribute: 'yes' }],
    ['malformed month', { ...valid, month: '2026-9' }],
    ['month too far ahead', { ...valid, month: '2026-11' }],
    ['month too far behind', { ...valid, month: '2026-07' }],
    ['auto-contribute without a monthly amount', { ...valid, monthlyAmount: null, autoContribute: true }],
  ])('returns 400 for %s', async (_label, body) => {
    const spy = vi.spyOn(store, 'put');
    const res = await putPot(putEvent(body), 'user-1', { categoryId: 'cat-holidays' });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await putPot({ body: '{', requestContext: {} } as unknown as APIGatewayProxyEventV2, 'user-1', { categoryId: 'cat-holidays' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when the category is not a pot', async () => {
    const spy = vi.spyOn(store, 'put');
    const res = await putPot(putEvent(valid), 'user-1', { categoryId: 'cat-groceries' });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 404 when a custom category does not exist', async () => {
    const res = await putPot(putEvent(valid), 'user-1', { categoryId: 'custom-missing' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an unknown pot even when the body is invalid', async () => {
    const res = await putPot(putEvent({}), 'user-1', { categoryId: 'custom-missing' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when a custom category is not a pot', async () => {
    await seedUser(store, 'user-1', [{ SK: 'CAT#custom-1', categoryId: 'custom-1', type: 'EXPENSE' }]);
    const res = await putPot(putEvent(valid), 'user-1', { categoryId: 'custom-1' });
    expect(res.statusCode).toBe(400);
  });

  it('saves settings for a default pot without auto-contribute', async () => {
    const res = await putPot(putEvent(valid), 'user-1', { categoryId: 'cat-holidays' });
    expect(res.statusCode).toBe(200);
    expect(await store.get({ PK: 'USER#user-1', SK: 'POT#cat-holidays' })).toMatchObject({
      PK: 'USER#user-1', SK: 'POT#cat-holidays', categoryId: 'cat-holidays',
      monthlyAmount: 5000, goalAmount: 300000, autoContribute: [],
    });
    expect(JSON.parse(res.body).settings.categoryId).toBe('cat-holidays');
  });

  it('starts auto-contribute from the saved month using the monthly amount', async () => {
    const res = await putPot(putEvent({ ...valid, autoContribute: true }), 'user-1', { categoryId: 'cat-holidays' });
    expect(JSON.parse(res.body).settings.autoContribute).toEqual([{ from: '2026-09', amount: 5000 }]);
  });

  it('refuses to change an archived pot and leaves its settings alone', async () => {
    const archived = { SK: 'POT#cat-holidays', categoryId: 'cat-holidays', monthlyAmount: null, goalAmount: null, autoContribute: [], archivedAt: '2026-09-20T10:00:00.000Z', updatedAt: 'u' };
    await seedUser(store, 'user-1', [archived]);
    const res = await putPot(putEvent(valid), 'user-1', { categoryId: 'cat-holidays' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unarchive this pot before changing it' });
    expect(await store.get({ PK: 'USER#user-1', SK: 'POT#cat-holidays' })).toMatchObject({ archivedAt: '2026-09-20T10:00:00.000Z', updatedAt: 'u', monthlyAmount: null });
  });

  it('allows clearing both amounts', async () => {
    const res = await putPot(putEvent({ monthlyAmount: null, goalAmount: null, autoContribute: false, month: '2026-09' }), 'user-1', { categoryId: 'cat-holidays' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 when the entry list would exceed the cap', async () => {
    const full: PotAutoEntry[] = Array.from({ length: MAX_AUTO_ENTRIES }, (_, i) => ({
      from: `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, amount: i % 2 === 0 ? 100 : 0,
    }));
    await seedUser(store, 'user-1', [{ SK: 'POT#cat-holidays', categoryId: 'cat-holidays', monthlyAmount: 5000, goalAmount: null, autoContribute: full }]);
    const res = await putPot(putEvent({ ...valid, autoContribute: true, monthlyAmount: 4242 }), 'user-1', { categoryId: 'cat-holidays' });
    expect(res.statusCode).toBe(400);
  });

  it('stores settings with archivedAt as a real null, not a missing attribute', async () => {
    await seedUser(store, 'user-1', [{ SK: 'CAT#custom-pot', categoryId: 'custom-pot', name: 'Garden', type: 'POT', icon: 'star', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' }]);
    const res = await putPot(
      putEvent({ monthlyAmount: 5000, goalAmount: null, autoContribute: false, month: '2026-09' }),
      'user-1',
      { categoryId: 'custom-pot' },
    );
    expect(res.statusCode).toBe(200);
    const stored = await store.get({ PK: 'USER#user-1', SK: 'POT#custom-pot' });
    expect(stored).toMatchObject({ monthlyAmount: 5000, goalAmount: null, archivedAt: null });
  });
});
