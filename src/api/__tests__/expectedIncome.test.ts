import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getExpectedIncome, putExpectedIncome, deleteExpectedIncome } from '../expectedIncome';
import { MAX_AMOUNT_PENCE } from '../constants';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { resetTestStore, useTestStore } from '../../store/testing';

beforeEach(() => { useTestStore(); });
afterEach(() => { resetTestStore(); });

function makeEvent(body?: unknown): APIGatewayProxyEventV2 {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    queryStringParameters: {},
    requestContext: { http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

async function amountFor(userId: string): Promise<unknown> {
  const res = await getExpectedIncome(makeEvent(), userId, {});
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body).amount;
}

describe('expected income', () => {
  it('GET returns null before anything is set', async () => {
    expect(await amountFor('user-1')).toBeNull();
  });

  it('PUT stores and GET returns 500000', async () => {
    const put = await putExpectedIncome(makeEvent({ amount: 500000 }), 'user-1', {});
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.body)).toEqual({ amount: 500000 });
    expect(await amountFor('user-1')).toBe(500000);
  });

  it('PUT accepts the maximum amount', async () => {
    const put = await putExpectedIncome(makeEvent({ amount: MAX_AMOUNT_PENCE }), 'user-1', {});
    expect(put.statusCode).toBe(200);
  });

  it.each([0, -1, 1.5, '5000', MAX_AMOUNT_PENCE + 1, null])('PUT rejects %s with 400', async (amount) => {
    const res = await putExpectedIncome(makeEvent({ amount }), 'user-1', {});
    expect(res.statusCode).toBe(400);
    expect(await amountFor('user-1')).toBeNull();
  });

  it('PUT rejects a missing or invalid body with 400', async () => {
    expect((await putExpectedIncome(makeEvent({}), 'user-1', {})).statusCode).toBe(400);
    expect((await putExpectedIncome(makeEvent(), 'user-1', {})).statusCode).toBe(400);
  });

  it('DELETE clears it so GET returns null', async () => {
    await putExpectedIncome(makeEvent({ amount: 500000 }), 'user-1', {});
    const del = await deleteExpectedIncome(makeEvent(), 'user-1', {});
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body)).toEqual({ amount: null });
    expect(await amountFor('user-1')).toBeNull();
  });

  it("one person's value is not visible to another user", async () => {
    await putExpectedIncome(makeEvent({ amount: 500000 }), 'user-1', {});
    expect(await amountFor('user-2')).toBeNull();
  });
});
