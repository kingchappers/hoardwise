import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../../api-handler';
import { setAuth } from '../../auth';
import { setStore } from '../../store';
import { MemoryStore } from '../../store/memory';
import type { ApiResponse } from '../types';
import { loadSpec, operations } from './openapiSpec';
import type { SpecOperation } from './openapiSpec';

// Every route that reads a JSON body must answer 400, never 500, when the body is not a JSON object. The routes come
// from docs/openapi.yaml, so a new route with a request body is covered automatically.
const CLOCK = '2026-10-30T12:00:00Z';
const USER = 'json-body-user';
const BAD_BODIES = ['null', '[]', '"text"', '123', 'true', '{'];

type Json = any;

const bodyOps: SpecOperation[] = operations(loadSpec()).filter((op) => (op.operation as Json).requestBody !== undefined);
const keyOf = (op: SpecOperation): string => `${op.method} ${op.template}`;

let store: MemoryStore;
let savedOrigin: string | undefined;
let ids: Record<string, string>;

async function call(method: string, template: string, path: Record<string, string>, body: string | undefined): Promise<{ status: number; json: Json; text: string }> {
  let rawPath = template;
  for (const [name, value] of Object.entries(path)) rawPath = rawPath.replace(`{${name}}`, encodeURIComponent(value));
  const event = {
    rawPath,
    headers: {},
    body,
    requestContext: { routeKey: `${method} ${template}`, http: { method, sourceIp: '203.0.113.1' } },
  } as unknown as APIGatewayProxyEventV2;
  const response = (await handler(event, {} as Context, () => {})) as ApiResponse;
  const text = response.body ?? '';
  let json: Json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.statusCode, json, text };
}

async function seed(method: string, template: string, body: unknown, path: Record<string, string> = {}): Promise<Json> {
  const reply = await call(method, template, path, JSON.stringify(body));
  expect(reply.status, `seed ${method} ${template}: ${reply.text}`).toBeLessThan(300);
  return reply.json;
}

// Path ids that exist, so a 400 can only come from the body check and not from a 404.
function pathFor(op: SpecOperation): Record<string, string> {
  const path: Record<string, string> = {};
  for (const name of [...op.template.matchAll(/\{(\w+)\}/g)].map((match) => match[1])) {
    if (name === 'categoryId') path[name] = op.template.startsWith('/api/pots') ? ids.potCategory : ids.category;
    else path[name] = ids[name];
  }
  return path;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CLOCK));
  store = new MemoryStore();
  setStore(store);
  savedOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://hoard.example';
  setAuth({ mode: 'auth0', authenticate: vi.fn().mockResolvedValue({ userId: USER }), handlePublic: async () => undefined });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const category = await seed('POST', '/api/categories', { name: 'Hobbies', type: 'EXPENSE', icon: 'star', group: 'EVERYDAY' });
  const pot = await seed('POST', '/api/categories', { name: 'Holiday', type: 'POT', icon: 'star' });
  const transaction = await seed('POST', '/api/transactions', {
    categoryId: category.category.categoryId,
    type: 'EXPENSE',
    amount: 1250,
    date: '2026-10-12',
    description: 'Lunch',
  });
  const account = await seed('POST', '/api/accounts', { name: 'Current', kind: 'ASSET', type: 'CASH' });
  const recurring = await seed('POST', '/api/recurring', {
    type: 'EXPENSE',
    description: 'Rent',
    categoryId: category.category.categoryId,
    amount: 80000,
    frequency: 'MONTHLY',
    dayOfMonth: 1,
  });
  ids = {
    category: category.category.categoryId,
    potCategory: pot.category.categoryId,
    yearMonth: transaction.transaction.yearMonth,
    transactionId: transaction.transaction.transactionId,
    accountId: account.account.accountId,
    recurringId: recurring.recurring.recurringId,
  };
});

afterEach(() => {
  if (savedOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = savedOrigin;
  setAuth(undefined);
  setStore(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a JSON body that is not an object', () => {
  it('finds the routes that read a JSON body in docs/openapi.yaml', () => {
    expect(bodyOps.length).toBeGreaterThanOrEqual(14);
  });

  describe.each(bodyOps.map((op) => [keyOf(op), op] as const))('%s', (_key, op) => {
    it.each(BAD_BODIES)('answers 400 with an error message for %s', async (body) => {
      const reply = await call(op.method, op.template, pathFor(op), body);
      expect(reply.status, reply.text).toBe(400);
      expect(typeof reply.json?.error).toBe('string');
    });

    it('answers its normal field 400 for an empty body, not a 500', async () => {
      const reply = await call(op.method, op.template, pathFor(op), undefined);
      expect(reply.status, reply.text).toBe(400);
      expect(typeof reply.json?.error).toBe('string');
    });
  });
});
