import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getTransactions, createTransaction, deleteTransaction, updateTransaction, validateTransactionInput } from '../transactions';
import { MAX_AMOUNT_PENCE } from '../constants';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { SqliteStore } from '../../store/sqlite';
import { resetTestStore, seedUser, useTestStore } from '../../store/testing';

let store: SqliteStore;
beforeEach(() => { store = useTestStore(); });
afterEach(() => { resetTestStore(); });

function makeEvent(opts: {
  body?: object;
  query?: Record<string, string>;
  params?: Record<string, string>;
} = {}): APIGatewayProxyEventV2 {
  return {
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    queryStringParameters: opts.query || {},
    pathParameters: opts.params,
    requestContext: { http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

describe('getTransactions', () => {
  it('returns transactions for a valid year and month', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2025-01#txn-1', transactionId: 'txn-1' }]);
    const res = await getTransactions(makeEvent({ query: { year: '2025', month: '1' } }), 'user-1', {});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).transactions).toHaveLength(1);
  });

  it('returns only the public transaction fields, without storage keys', async () => {
    await seedUser(store, 'user-1', [{
      SK: 'TXN#2025-01#txn-1', transactionId: 'txn-1', yearMonth: '2025-01', amount: 1250, type: 'EXPENSE',
      categoryId: 'cat-a', description: 'Shop', date: '2025-01-05', createdAt: '2025-01-05T10:00:00.000Z',
      recurringId: 'rec-1',
    }]);
    const res = await getTransactions(makeEvent({ query: { year: '2025', month: '1' } }), 'user-1', {});
    expect(JSON.parse(res.body).transactions).toEqual([{
      transactionId: 'txn-1', yearMonth: '2025-01', amount: 1250, type: 'EXPENSE', categoryId: 'cat-a',
      description: 'Shop', date: '2025-01-05', createdAt: '2025-01-05T10:00:00.000Z', recurringId: 'rec-1',
    }]);
  });

  it('maps legacy rows without a recurringId or with an empty createdAt', async () => {
    const base = { yearMonth: '2025-01', amount: 100, type: 'EXPENSE', categoryId: 'cat-a', description: '', date: '2025-01-05' };
    await seedUser(store, 'user-1', [
      { SK: 'TXN#2025-01#txn-1', transactionId: 'txn-1', ...base, createdAt: '' },
      { SK: 'TXN#2025-01#txn-2', transactionId: 'txn-2', ...base, createdAt: '2025-01-05T10:00:00.000Z' },
    ]);
    const res = await getTransactions(makeEvent({ query: { year: '2025', month: '1' } }), 'user-1', {});
    expect(JSON.parse(res.body).transactions).toEqual([
      { transactionId: 'txn-1', ...base, createdAt: '' },
      { transactionId: 'txn-2', ...base, createdAt: '2025-01-05T10:00:00.000Z' },
    ]);
  });

  it('returns 400 when year or month is missing', async () => {
    const spy = vi.spyOn(store, 'query');
    const res = await getTransactions(makeEvent({ query: { year: '2025' } }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid month', async () => {
    const res = await getTransactions(makeEvent({ query: { year: '2025', month: '13' } }), 'user-1', {});
    expect(res.statusCode).toBe(400);
  });
});

describe('createTransaction', () => {
  it('creates a transaction and returns 201', async () => {
    const res = await createTransaction(
      makeEvent({ body: { amount: 1500, type: 'EXPENSE', categoryId: 'cat-food', description: 'Tesco', date: '2025-01-15' } }),
      'user-1',
      {},
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.transaction.amount).toBe(1500);
    expect(body.transaction.yearMonth).toBe('2025-01');
  });

  it('returns 400 for non-integer amount', async () => {
    const spy = vi.spyOn(store, 'put');
    const res = await createTransaction(
      makeEvent({ body: { amount: 15.50, type: 'EXPENSE', categoryId: 'cat-food', description: 'Tesco', date: '2025-01-15' } }),
      'user-1',
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid date format', async () => {
    const res = await createTransaction(
      makeEvent({ body: { amount: 1500, type: 'EXPENSE', categoryId: 'cat-food', description: 'Tesco', date: '15/01/2025' } }),
      'user-1',
      {},
    );
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid transaction type', async () => {
    const res = await createTransaction(
      makeEvent({ body: { amount: 1500, type: 'INVALID', categoryId: 'cat-food', description: 'Tesco', date: '2025-01-15' } }),
      'user-1',
      {},
    );
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for description over 200 chars', async () => {
    const res = await createTransaction(
      makeEvent({ body: { amount: 100, type: 'EXPENSE', categoryId: 'cat-food', description: 'a'.repeat(201), date: '2025-01-15' } }),
      'user-1',
      {},
    );
    expect(res.statusCode).toBe(400);
  });

  it.each(['SET_ASIDE', 'TAKE_OUT'])('accepts %s as a transaction type', async (type) => {
    const res = await createTransaction(makeEvent({
      body: { amount: 30000, type, categoryId: 'cat-holidays', description: 'Monthly contribution', date: '2026-07-15' },
    }), 'user-1', {});
    expect(res.statusCode).toBe(201);
  });

  it.each(['INVESTMENT_IN', 'INVESTMENT_OUT'])('rejects the removed %s type', async (type) => {
    const spy = vi.spyOn(store, 'put');
    const res = await createTransaction(makeEvent({
      body: { amount: 30000, type, categoryId: 'cat-holidays', description: 'Old type', date: '2026-07-15' },
    }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects the old INVESTMENT_GAIN type', async () => {
    const spy = vi.spyOn(store, 'put');
    const res = await createTransaction(makeEvent({
      body: { amount: 30000, type: 'INVESTMENT_GAIN', categoryId: 'cat-stocks', description: 'Old type', date: '2026-07-15' },
    }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('creates a transaction with no description', async () => {
    const res = await createTransaction(makeEvent({
      body: { amount: 480, type: 'EXPENSE', categoryId: 'cat-dining', date: '2026-07-15' },
    }), 'user-1', {});
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).transaction.description).toBe('');
  });

  it('still rejects a description longer than 200 characters', async () => {
    const res = await createTransaction(makeEvent({
      body: { amount: 480, type: 'EXPENSE', categoryId: 'cat-dining', description: 'x'.repeat(201), date: '2026-07-15' },
    }), 'user-1', {});
    expect(res.statusCode).toBe(400);
  });

  it('uses a client-supplied transactionId when present', async () => {
    const clientId = '11111111-1111-4111-8111-111111111111';
    const event = makeEvent({
      body: {
        amount: 500, type: 'EXPENSE', categoryId: 'cat-1', description: '', date: '2025-01-05',
        transactionId: clientId,
      },
    });
    const res = await createTransaction(event, 'user-1', {});
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(201);
    expect(body.transaction.transactionId).toBe(clientId);
  });

  it('rejects a malformed transactionId', async () => {
    const event = makeEvent({
      body: {
        amount: 500, type: 'EXPENSE', categoryId: 'cat-1', description: '', date: '2025-01-05',
        transactionId: 'not-a-uuid',
      },
    });
    const res = await createTransaction(event, 'user-1', {});
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/transactionId/);
  });

  it('still generates its own id when transactionId is absent', async () => {
    const event = makeEvent({ body: { amount: 500, type: 'EXPENSE', categoryId: 'cat-1', description: '', date: '2025-01-05' } });
    const res = await createTransaction(event, 'user-1', {});
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(201);
    expect(body.transaction.transactionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('validateTransactionInput', () => {
  const valid = { amount: 480, type: 'EXPENSE', categoryId: 'cat-dining', description: 'Pret', date: '2026-07-15' };

  it('accepts a valid body', () => {
    const res = validateTransactionInput(valid);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.amount).toBe(480);
  });

  it('rejects a non-integer amount', () => {
    const res = validateTransactionInput({ ...valid, amount: 4.8 });
    expect(res.ok).toBe(false);
  });

  it('rejects a zero amount', () => {
    const res = validateTransactionInput({ ...valid, amount: 0 });
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown type', () => {
    const res = validateTransactionInput({ ...valid, type: 'NOPE' });
    expect(res.ok).toBe(false);
  });

  it('rejects a malformed date', () => {
    const res = validateTransactionInput({ ...valid, date: '15-07-2026' });
    expect(res.ok).toBe(false);
  });

  it('defaults a missing description to empty string', () => {
    const { description, ...noDesc } = valid;
    const res = validateTransactionInput(noDesc);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.description).toBe('');
  });
});

describe('deleteTransaction', () => {
  it('moves the transaction to the trash in one transaction and returns 204', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2025-01#some-uuid', transactionId: 'some-uuid' }]);
    const res = await deleteTransaction(makeEvent(), 'user-1', { yearMonth: '2025-01', transactionId: 'some-uuid' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2025-01#some-uuid' })).toBeUndefined();
    expect(await store.get({ PK: 'USER#user-1', SK: 'TRASH#TRANSACTION#2025-01#some-uuid' })).toMatchObject({
      entityType: 'TRANSACTION', item: { transactionId: 'some-uuid' },
    });
  });

  it('returns 204 without writing when the transaction is already gone', async () => {
    const spy = vi.spyOn(store, 'transact');
    const res = await deleteTransaction(makeEvent(), 'user-1', { yearMonth: '2025-01', transactionId: 'some-uuid' });
    expect(res.statusCode).toBe(204);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid yearMonth format', async () => {
    const spy = vi.spyOn(store, 'get');
    const res = await deleteTransaction(makeEvent(), 'user-1', { yearMonth: '01-2025', transactionId: 'uuid' });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 when transactionId is missing', async () => {
    const res = await deleteTransaction(makeEvent(), 'user-1', { yearMonth: '2025-01' });
    expect(res.statusCode).toBe(400);
  });
});

describe('updateTransaction', () => {
  const existing = {
    transactionId: 'txn-1', yearMonth: '2026-07', amount: 480, type: 'EXPENSE',
    categoryId: 'cat-dining', description: 'Pret', date: '2026-07-15',
    createdAt: '2026-07-15T09:00:00.000Z',
  };
  const params = { yearMonth: '2026-07', transactionId: 'txn-1' };

  it('updates a transaction within the same month', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-07#txn-1', ...existing }]);
    const spy = vi.spyOn(store, 'transact');
    const res = await updateTransaction(makeEvent({
      body: { amount: 520, type: 'EXPENSE', categoryId: 'cat-dining', description: 'Pret coffee', date: '2026-07-16' },
    }), 'user-1', params);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.transaction.amount).toBe(520);
    expect(body.transaction.transactionId).toBe('txn-1');
    expect(body.transaction.createdAt).toBe('2026-07-15T09:00:00.000Z');
    expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-07#txn-1' })).toMatchObject({ amount: 520 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 404 when the transaction does not exist', async () => {
    const res = await updateTransaction(makeEvent({
      body: { amount: 520, type: 'EXPENSE', categoryId: 'cat-dining', description: 'x', date: '2026-07-16' },
    }), 'user-1', params);
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an unknown transaction even when the body is invalid', async () => {
    const res = await updateTransaction(makeEvent({ body: {} }), 'user-1', params);
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for an invalid body on a transaction that exists, changing nothing', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-07#txn-1', ...existing }]);
    const res = await updateTransaction(makeEvent({ body: { amount: -1 } }), 'user-1', params);
    expect(res.statusCode).toBe(400);
    expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-07#txn-1' })).toMatchObject({ amount: 480 });
  });

  it('moves the item transactionally when the month changes', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-07#txn-1', ...existing }]);
    const spy = vi.spyOn(store, 'transact');
    const res = await updateTransaction(makeEvent({
      body: { amount: 480, type: 'EXPENSE', categoryId: 'cat-dining', description: 'Pret', date: '2026-08-02' },
    }), 'user-1', params);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).transaction.yearMonth).toBe('2026-08');

    expect(spy).toHaveBeenCalledOnce();
    expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-07#txn-1' })).toBeUndefined();
    expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-08#txn-1' })).toMatchObject({ yearMonth: '2026-08' });
  });

  it('returns 400 for an invalid amount, writing nothing', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-07#txn-1', ...existing }]);
    const spy = vi.spyOn(store, 'put');
    const res = await updateTransaction(makeEvent({
      body: { amount: -5, type: 'EXPENSE', categoryId: 'cat-dining', description: 'x', date: '2026-07-16' },
    }), 'user-1', params);
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed yearMonth param', async () => {
    const res = await updateTransaction(makeEvent({
      body: { amount: 480, type: 'EXPENSE', categoryId: 'cat-dining', description: 'x', date: '2026-07-16' },
    }), 'user-1', { yearMonth: '07-2026', transactionId: 'txn-1' });
    expect(res.statusCode).toBe(400);
  });
});

describe('validateTransactionInput amount cap', () => {
  const body = { type: 'EXPENSE', categoryId: 'cat-holidays', description: '', date: '2026-07-15' };

  it('accepts an amount of exactly the cap', () => {
    expect(validateTransactionInput({ ...body, amount: MAX_AMOUNT_PENCE }).ok).toBe(true);
  });

  it('rejects an amount one pence over the cap', () => {
    const result = validateTransactionInput({ ...body, amount: MAX_AMOUNT_PENCE + 1 });
    expect(result.ok).toBe(false);
  });
});

describe('recurringId on transactions', () => {
  const recurringId = '3f2b8c1e-9a4d-4e7f-b1c2-0d9e8f7a6b5c';
  const base = { amount: 1500, type: 'EXPENSE', categoryId: 'cat-food', description: 'Rent', date: '2026-09-01' };
  const existing = {
    transactionId: 'txn-1', yearMonth: '2026-09', ...base, createdAt: '2026-09-01T09:00:00.000Z', recurringId,
  };
  const params = { yearMonth: '2026-09', transactionId: 'txn-1' };

  it('stores the recurringId a transaction was added from', async () => {
    const res = await createTransaction(makeEvent({ body: { ...base, recurringId } }), 'user-1', {});
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).transaction.recurringId).toBe(recurringId);
    const [stored] = await store.query('USER#user-1', { skPrefix: 'TXN#2026-09' });
    expect(stored.recurringId).toBe(recurringId);
  });

  it('leaves the attribute out when no recurringId is sent', async () => {
    await createTransaction(makeEvent({ body: base }), 'user-1', {});
    const [stored] = await store.query('USER#user-1', { skPrefix: 'TXN#2026-09' });
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('recurringId');
  });

  it.each([
    ['a number', 42],
    ['an empty string', ''],
    ['a non-UUID string', 'rent-bill'],
    ['a string over 100 characters', `${recurringId}${'a'.repeat(70)}`],
  ])('rejects %s', async (_label, value) => {
    const spy = vi.spyOn(store, 'put');
    const res = await createTransaction(makeEvent({ body: { ...base, recurringId: value } }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the stored recurringId when an update omits it', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-09#txn-1', ...existing }]);
    const res = await updateTransaction(makeEvent({ body: { ...base, amount: 1600 } }), 'user-1', params);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).transaction.recurringId).toBe(recurringId);
    expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-09#txn-1' })).toMatchObject({ recurringId, amount: 1600 });
  });

  it('links a manual transaction when an update sends a recurringId', async () => {
    const { recurringId: _omit, ...manual } = existing;
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-09#txn-1', ...manual }]);
    const res = await updateTransaction(makeEvent({ body: { ...base, recurringId } }), 'user-1', params);
    expect(JSON.parse(res.body).transaction.recurringId).toBe(recurringId);
  });

  it('rejects an invalid recurringId on update, writing nothing', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-09#txn-1', ...existing }]);
    const spy = vi.spyOn(store, 'put');
    const res = await updateTransaction(makeEvent({ body: { ...base, recurringId: 'nope' } }), 'user-1', params);
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('createTransaction without a recurring link', () => {
  it('stores no recurringId attribute at all', async () => {
    const res = await createTransaction(
      makeEvent({ body: { amount: 350, type: 'EXPENSE', categoryId: 'cat-dining', description: 'Coffee', date: '2026-10-02' } }),
      'user-1',
      {},
    );
    expect(res.statusCode).toBe(201);
    const [stored] = await store.query('USER#user-1', { skPrefix: 'TXN#2026-10' });
    expect(stored).toBeDefined();
    expect('recurringId' in stored).toBe(false);
  });

  it('moves a transaction to the new month in one step when its date changes month', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-09#t1', transactionId: 't1', yearMonth: '2026-09', amount: 100, type: 'EXPENSE', categoryId: 'cat-dining', description: '', date: '2026-09-30', createdAt: '2026-09-30T00:00:00.000Z' }]);
    const spy = vi.spyOn(store, 'transact');
    const res = await updateTransaction(
      makeEvent({ body: { amount: 100, type: 'EXPENSE', categoryId: 'cat-dining', description: '', date: '2026-10-01' } }),
      'user-1',
      { yearMonth: '2026-09', transactionId: 't1' },
    );
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-09#t1' })).toBeUndefined();
    expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-10#t1' })).toMatchObject({ yearMonth: '2026-10', createdAt: '2026-09-30T00:00:00.000Z' });
  });
});

describe('strict month and date validation (HOA-46)', () => {
  const base = { amount: 1500, type: 'EXPENSE', categoryId: 'cat-food', description: 'Rent', date: '2026-09-01' };
  const recurringId = '3f2b8c1e-9a4d-4e7f-b1c2-0d9e8f7a6b5c';
  const otherId = '8a7e3c1d-5b2f-4e60-9d14-7c2b1a0f3e55';
  const stored = { transactionId: 'txn-1', yearMonth: '2026-09', ...base, createdAt: '2026-09-01T09:00:00.000Z' };
  const params = { yearMonth: '2026-09', transactionId: 'txn-1' };

  it.each([
    ['2026x', '10'], ['2026', '1x'], ['26', '10'], ['1999', '10'], ['2026', '0'], ['2026', '013'], [' 2026', '10'], ['2026', '1.5'],
  ])('lists nothing and returns 400 for year %s month %s', async (year, month) => {
    const spy = vi.spyOn(store, 'query');
    const res = await getTransactions(makeEvent({ query: { year, month } }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid year or month');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([['2026', '9'], ['2026', '09']])('accepts year %s month %s', async (year, month) => {
    const res = await getTransactions(makeEvent({ query: { year, month } }), 'user-1', {});
    expect(res.statusCode).toBe(200);
  });

  it.each(['2026-13-45', '2026-02-30', '2026-00-10'])('rejects the date %s on create', async (date) => {
    const spy = vi.spyOn(store, 'put');
    const res = await createTransaction(makeEvent({ body: { ...base, date } }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('date must be a real date in YYYY-MM-DD format');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(['2026-13-45', '2026-02-30'])('rejects the date %s on update', async (date) => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-09#txn-1', ...stored }]);
    const res = await updateTransaction(makeEvent({ body: { ...base, date } }), 'user-1', params);
    expect(res.statusCode).toBe(400);
    expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-09#txn-1' })).toMatchObject({ date: '2026-09-01' });
  });

  it('accepts a leap day', async () => {
    const res = await createTransaction(makeEvent({ body: { ...base, date: '2028-02-29' } }), 'user-1', {});
    expect(res.statusCode).toBe(201);
  });

  it.each(['2026-13', '2026-00', '2026-1', 'October'])('rejects the yearMonth %s on update and delete', async (yearMonth) => {
    const put = await updateTransaction(makeEvent({ body: base }), 'user-1', { yearMonth, transactionId: 'txn-1' });
    expect(put.statusCode).toBe(400);
    expect(JSON.parse(put.body).error).toBe('yearMonth must be in YYYY-MM format');
    const del = await deleteTransaction(makeEvent(), 'user-1', { yearMonth, transactionId: 'txn-1' });
    expect(del.statusCode).toBe(400);
    expect(JSON.parse(del.body).error).toBe('yearMonth must be in YYYY-MM format');
  });

  it('still lists a stored transaction whose date is not a real date', async () => {
    await seedUser(store, 'user-1', [{ SK: 'TXN#2026-09#txn-1', ...stored, date: '2026-09-45' }]);
    const res = await getTransactions(makeEvent({ query: { year: '2026', month: '9' } }), 'user-1', {});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).transactions[0].date).toBe('2026-09-45');
  });

  describe('recurringId on update', () => {
    const linked = { ...stored, recurringId };

    it('unlinks when recurringId is null', async () => {
      await seedUser(store, 'user-1', [{ SK: 'TXN#2026-09#txn-1', ...linked }]);
      const res = await updateTransaction(makeEvent({ body: { ...base, recurringId: null } }), 'user-1', params);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).transaction).not.toHaveProperty('recurringId');
      expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-09#txn-1' })).not.toHaveProperty('recurringId');
    });

    it('keeps the link when recurringId is omitted', async () => {
      await seedUser(store, 'user-1', [{ SK: 'TXN#2026-09#txn-1', ...linked }]);
      const res = await updateTransaction(makeEvent({ body: base }), 'user-1', params);
      expect(JSON.parse(res.body).transaction.recurringId).toBe(recurringId);
    });

    it('replaces the link when a UUID is sent', async () => {
      await seedUser(store, 'user-1', [{ SK: 'TXN#2026-09#txn-1', ...linked }]);
      const res = await updateTransaction(makeEvent({ body: { ...base, recurringId: otherId } }), 'user-1', params);
      expect(JSON.parse(res.body).transaction.recurringId).toBe(otherId);
    });

    it('unlinks when the update also moves the month', async () => {
      await seedUser(store, 'user-1', [{ SK: 'TXN#2026-09#txn-1', ...linked }]);
      const res = await updateTransaction(makeEvent({ body: { ...base, date: '2026-10-01', recurringId: null } }), 'user-1', params);
      expect(res.statusCode).toBe(200);
      expect(await store.get({ PK: 'USER#user-1', SK: 'TXN#2026-10#txn-1' })).not.toHaveProperty('recurringId');
    });
  });

  describe('create semantics', () => {
    it('treats recurringId null on create as no link', async () => {
      const res = await createTransaction(makeEvent({ body: { ...base, recurringId: null } }), 'user-1', {});
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).transaction).not.toHaveProperty('recurringId');
      const [item] = await store.query('USER#user-1', { skPrefix: 'TXN#2026-09' });
      expect(item).not.toHaveProperty('recurringId');
    });

    it('replaces a transaction when the client id already exists and still returns 201', async () => {
      const transactionId = '6f1d2c8e-3b4a-4c5d-8e9f-0a1b2c3d4e5f';
      const first = await createTransaction(makeEvent({ body: { ...base, transactionId } }), 'user-1', {});
      const second = await createTransaction(makeEvent({ body: { ...base, amount: 2000, transactionId } }), 'user-1', {});
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      const items = await store.query('USER#user-1', { skPrefix: 'TXN#2026-09' });
      expect(items).toHaveLength(1);
      expect(items[0].amount).toBe(2000);
    });

    it('accepts a categoryId and recurringId that match no record', async () => {
      const res = await createTransaction(
        makeEvent({ body: { ...base, categoryId: 'no-such-category', recurringId: otherId } }), 'user-1', {},
      );
      expect(res.statusCode).toBe(201);
    });
  });
});
