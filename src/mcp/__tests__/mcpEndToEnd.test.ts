import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../../api-handler';
import { setAuth } from '../../auth';
import { createToken } from '../../auth/tokens';
import { pk, txnSk } from '../../api/db';
import { setStore } from '../../store';
import { MemoryStore } from '../../store/memory';
import type { ApiResponse } from '../../api/types';

const NOW = new Date('2026-10-20T12:00:00.000Z');
let store: MemoryStore;
let token: string;
let requestCount = 0;
let seq = 0;

function post(body: unknown): APIGatewayProxyEventV2 {
  requestCount += 1;
  return {
    rawPath: '/mcp',
    // What a Streamable HTTP client sends with every POST.
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { routeKey: 'ANY /mcp', http: { method: 'POST', sourceIp: `198.51.100.${requestCount}` } },
  } as unknown as APIGatewayProxyEventV2;
}

async function call(body: unknown): Promise<ApiResponse> {
  return (await handler(post(body), {} as Context, () => {})) as ApiResponse;
}

async function addTx(date: string, type: 'EXPENSE' | 'INCOME', categoryId: string, amount: number): Promise<void> {
  seq += 1;
  const transactionId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const yearMonth = date.slice(0, 7);
  await store.put({
    PK: pk('user-a'),
    SK: txnSk(yearMonth, transactionId),
    transactionId,
    yearMonth,
    amount,
    type,
    categoryId,
    description: 'item',
    date,
    createdAt: `${date}T00:00:00.000Z`,
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  store = new MemoryStore();
  setStore(store);
  setAuth({
    mode: 'auth0',
    authenticate: vi.fn().mockResolvedValue({ userId: 'jwt-user' }),
    handlePublic: vi.fn().mockResolvedValue(undefined),
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  ({ token } = await createToken(store, { userId: 'user-a', name: 'agent', scope: 'read', expiryDays: 90 }, Math.floor(NOW.getTime() / 1000)));

  // May to August: 1,000.00 of groceries (10 x 100.00) and 2,000.00 of salary each month.
  for (const month of ['2026-05', '2026-06', '2026-07', '2026-08']) {
    for (let day = 1; day <= 10; day += 1) await addTx(`${month}-${String(day).padStart(2, '0')}`, 'EXPENSE', 'cat-groceries', 10000);
    await addTx(`${month}-02`, 'INCOME', 'cat-salary', 200000);
  }
  // September: 3,000.00 of groceries (10 x 300.00), well above the usual 1,000.00, and the same salary.
  for (let day = 1; day <= 10; day += 1) await addTx(`2026-09-${String(day).padStart(2, '0')}`, 'EXPENSE', 'cat-groceries', 30000);
  await addTx('2026-09-02', 'INCOME', 'cat-salary', 200000);
});

afterEach(() => {
  setAuth(undefined);
  setStore(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('MCP session through the real handler', () => {
  it('initializes, lists tools and reviews a month', async () => {
    const init = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    expect(init.statusCode).toBe(200);
    expect(JSON.parse(init.body).result.protocolVersion).toBe('2025-06-18');

    const initialized = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(initialized.statusCode).toBe(202);

    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = JSON.parse(list.body).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['month_review', 'category_detail', 'pots_overview', 'chart_data', 'display_guidance']);

    const review = await call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'month_review', arguments: { month: '2026-09' } },
    });
    expect(review.statusCode).toBe(200);
    const result = JSON.parse(review.body).result;
    expect(result.isError).not.toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.month).toBe('2026-09');
    expect(data.income.logged).toBe(200000);
    expect(data.spending.total).toBe(300000);
    expect(data.spending.usual).toBe(100000);
    expect(data.notable).toContainEqual(expect.objectContaining({ kind: 'category-above-usual', categoryId: 'cat-groceries', amount: 300000, gap: 200000 }));
  });
});
