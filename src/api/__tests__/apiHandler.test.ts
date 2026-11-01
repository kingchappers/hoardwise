import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';

const { mockVerify, mockGetSigningKey, h } = vi.hoisted(() => {
  process.env.AUTH0_DOMAIN = 'tenant.example.com';
  process.env.AUTH0_AUDIENCE = 'https://api.example.com';
  const names = [
    'getCategories', 'createCategory', 'updateCategory', 'deleteCategory', 'reassignCategory',
    'getTransactions', 'createTransaction', 'deleteTransaction', 'updateTransaction', 'getTransactionsRange',
    'getTargets', 'upsertTarget', 'deleteTarget',
    'getPots', 'putPot', 'archivePot', 'unarchivePot',
    'getRecurring', 'createRecurring', 'updateRecurring', 'deleteRecurring', 'setRecurringHandled',
    'getAccounts', 'createAccount', 'updateAccount', 'deleteAccount', 'addBalance',
    'getTrash', 'restoreFromTrash',
    'createPushSubscription', 'deletePushSubscription',
  ];
  const fns: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries(names.map(name => [name, vi.fn()]));
  return { mockVerify: vi.fn(), mockGetSigningKey: vi.fn(), h: fns };
});

vi.mock('jsonwebtoken', () => ({ verify: mockVerify }));
vi.mock('jwks-rsa', () => ({ default: () => ({ getSigningKey: mockGetSigningKey }) }));
vi.mock('../categories', () => ({
  getCategories: h.getCategories, createCategory: h.createCategory, updateCategory: h.updateCategory, deleteCategory: h.deleteCategory,
}));
vi.mock('../reassign', () => ({ reassignCategory: h.reassignCategory }));
vi.mock('../transactions', () => ({
  getTransactions: h.getTransactions, createTransaction: h.createTransaction,
  deleteTransaction: h.deleteTransaction, updateTransaction: h.updateTransaction,
}));
vi.mock('../transactionsRange', () => ({ getTransactionsRange: h.getTransactionsRange }));
vi.mock('../targets', () => ({ getTargets: h.getTargets, upsertTarget: h.upsertTarget, deleteTarget: h.deleteTarget }));
vi.mock('../pots', () => ({ getPots: h.getPots, putPot: h.putPot }));
vi.mock('../potArchive', () => ({ archivePot: h.archivePot, unarchivePot: h.unarchivePot }));
vi.mock('../recurring', () => ({
  getRecurring: h.getRecurring, createRecurring: h.createRecurring, updateRecurring: h.updateRecurring,
  deleteRecurring: h.deleteRecurring, setRecurringHandled: h.setRecurringHandled,
}));
vi.mock('../accounts', () => ({
  getAccounts: h.getAccounts, createAccount: h.createAccount, updateAccount: h.updateAccount,
  deleteAccount: h.deleteAccount, addBalance: h.addBalance,
}));
vi.mock('../trash', () => ({ getTrash: h.getTrash, restoreFromTrash: h.restoreFromTrash }));
vi.mock('../push', () => ({ createPushSubscription: h.createPushSubscription, deletePushSubscription: h.deletePushSubscription }));
const { mockInitStore } = vi.hoisted(() => ({ mockInitStore: vi.fn() }));
vi.mock('../../store', () => ({ initStore: mockInitStore }));

import { handler } from '../../../api-handler';
import { SECURITY_HEADERS } from '../constants';

const TOKEN = 'secret-token-abc123';

function makeEvent(overrides: { method?: string; path?: string; authorization?: string | null } = {}): APIGatewayProxyEventV2 {
  const { method = 'GET', path = '/api/categories', authorization = `Bearer ${TOKEN}` } = overrides;
  return {
    rawPath: path,
    headers: authorization === null ? {} : { authorization },
    requestContext: { routeKey: `${method} /templated`, http: { method, sourceIp: '203.0.113.9' } },
  } as unknown as APIGatewayProxyEventV2;
}

async function invoke(event: APIGatewayProxyEventV2): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return (await handler(event, {} as Context, () => {})) as { statusCode: number; headers: Record<string, string>; body: string };
}

function handlerCalls(): string[] {
  return Object.entries(h).filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name);
}

function allowToken(claims: Record<string, unknown> = { sub: 'user-123' }): void {
  mockVerify.mockImplementation((_token, _getKey, _options, callback) => callback(null, claims));
}

function rejectToken(message = 'invalid signature'): void {
  mockVerify.mockImplementation((_token, _getKey, _options, callback) => callback(new Error(message)));
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockVerify.mockReset();
  mockGetSigningKey.mockReset();
  for (const [name, fn] of Object.entries(h)) {
    fn.mockReset().mockResolvedValue({ statusCode: 200, headers: {}, body: JSON.stringify({ handled: name }) });
  }
  allowToken();
  mockInitStore.mockReset().mockResolvedValue(undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authentication', () => {
  it('answers 401 with no token and never reaches a handler', async () => {
    const res = await invoke(makeEvent({ authorization: null }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Missing authorization token' });
    expect(res.headers).toEqual(SECURITY_HEADERS);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockInitStore).not.toHaveBeenCalled();
    expect(handlerCalls()).toEqual([]);
  });

  it('answers 401 for a header that has the Bearer prefix but no token', async () => {
    const res = await invoke(makeEvent({ authorization: 'Bearer ' }));
    expect(res.statusCode).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockInitStore).not.toHaveBeenCalled();
    expect(handlerCalls()).toEqual([]);
  });

  it('answers 401 for a token that fails verification, without saying why', async () => {
    rejectToken('jwt expired: details that must not leak');
    const res = await invoke(makeEvent());
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(res.body).not.toContain('expired');
    expect(res.headers).toEqual(SECURITY_HEADERS);
    expect(mockInitStore).not.toHaveBeenCalled();
    expect(handlerCalls()).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a number', 12345],
    ['an object', { id: 'user-123' }],
  ])('answers 401 for a verified token whose sub is %s', async (_label, sub) => {
    allowToken({ sub });
    const res = await invoke(makeEvent());
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(handlerCalls()).toEqual([]);
  });

  it('verifies with RS256 only, the configured audience and the tenant issuer', async () => {
    await invoke(makeEvent());
    expect(mockVerify).toHaveBeenCalledTimes(1);
    const [token, , options] = mockVerify.mock.calls[0];
    expect(token).toBe(TOKEN);
    expect(options).toEqual({ audience: 'https://api.example.com', issuer: 'https://tenant.example.com/', algorithms: ['RS256'] });
  });

  it('hands the handler the user id from the token, not anything from the request', async () => {
    allowToken({ sub: 'auth0|from-the-token' });
    const event = makeEvent({ path: '/api/categories' });
    (event.headers as Record<string, string>)['x-user-id'] = 'someone-else';
    await invoke(event);
    expect(h.getCategories).toHaveBeenCalledWith(event, 'auth0|from-the-token', {});
  });

  describe('looking up the signing key', () => {
    function signingKeyLookup(): (header: { kid: string }, callback: (err: Error | null, key?: string) => void) => void {
      return mockVerify.mock.calls[0][1];
    }

    it('asks the JWKS client for the key named in the token header and passes on its public key', async () => {
      await invoke(makeEvent());
      mockGetSigningKey.mockImplementation((_kid, callback) => callback(null, { getPublicKey: () => 'PUBLIC-KEY' }));
      const callback = vi.fn();
      signingKeyLookup()({ kid: 'key-1' }, callback);
      expect(mockGetSigningKey).toHaveBeenCalledWith('key-1', expect.any(Function));
      expect(callback).toHaveBeenCalledWith(null, 'PUBLIC-KEY');
    });

    it('passes a lookup failure on, so the token is refused', async () => {
      await invoke(makeEvent());
      const failure = new Error('no such key');
      mockGetSigningKey.mockImplementation((_kid, callback) => callback(failure));
      const callback = vi.fn();
      signingKeyLookup()({ kid: 'missing' }, callback);
      expect(callback).toHaveBeenCalledWith(failure);
    });
  });

  it('logs the templated route and never the token or the raw path', async () => {
    await invoke(makeEvent({ path: '/api/transactions/2026-09/t-private-id', method: 'DELETE' }));
    const logged = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]);
    expect(logged).toContain('DELETE /templated');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('t-private-id');
  });
});

describe('route table', () => {
  const routes: [string, string, string, Record<string, string>][] = [
    ['GET', '/api/categories', 'getCategories', {}],
    ['POST', '/api/categories', 'createCategory', {}],
    ['PUT', '/api/categories/c1', 'updateCategory', { categoryId: 'c1' }],
    ['DELETE', '/api/categories/c1', 'deleteCategory', { categoryId: 'c1' }],
    ['POST', '/api/categories/c1/reassign', 'reassignCategory', { categoryId: 'c1' }],
    ['GET', '/api/transactions', 'getTransactions', {}],
    ['POST', '/api/transactions', 'createTransaction', {}],
    ['PUT', '/api/transactions/2026-09/t1', 'updateTransaction', { yearMonth: '2026-09', transactionId: 't1' }],
    ['DELETE', '/api/transactions/2026-09/t1', 'deleteTransaction', { yearMonth: '2026-09', transactionId: 't1' }],
    ['GET', '/api/transactions/range', 'getTransactionsRange', {}],
    ['GET', '/api/targets', 'getTargets', {}],
    ['PUT', '/api/targets/c1', 'upsertTarget', { categoryId: 'c1' }],
    ['DELETE', '/api/targets/c1', 'deleteTarget', { categoryId: 'c1' }],
    ['GET', '/api/pots', 'getPots', {}],
    ['PUT', '/api/pots/p1', 'putPot', { categoryId: 'p1' }],
    ['POST', '/api/pots/p1/archive', 'archivePot', { categoryId: 'p1' }],
    ['POST', '/api/pots/p1/unarchive', 'unarchivePot', { categoryId: 'p1' }],
    ['GET', '/api/recurring', 'getRecurring', {}],
    ['POST', '/api/recurring', 'createRecurring', {}],
    ['PUT', '/api/recurring/r1', 'updateRecurring', { recurringId: 'r1' }],
    ['DELETE', '/api/recurring/r1', 'deleteRecurring', { recurringId: 'r1' }],
    ['POST', '/api/recurring/r1/handled', 'setRecurringHandled', { recurringId: 'r1' }],
    ['GET', '/api/accounts', 'getAccounts', {}],
    ['POST', '/api/accounts', 'createAccount', {}],
    ['PUT', '/api/accounts/a1', 'updateAccount', { accountId: 'a1' }],
    ['DELETE', '/api/accounts/a1', 'deleteAccount', { accountId: 'a1' }],
    ['POST', '/api/accounts/a1/balances', 'addBalance', { accountId: 'a1' }],
    ['GET', '/api/trash', 'getTrash', {}],
    ['POST', '/api/trash/restore', 'restoreFromTrash', {}],
    ['POST', '/api/push/subscriptions', 'createPushSubscription', {}],
    ['DELETE', '/api/push/subscriptions', 'deletePushSubscription', {}],
  ];

  it.each(routes)('%s %s goes to %s and to nothing else', async (method, path, name, params) => {
    const event = makeEvent({ method, path });
    const res = await invoke(event);
    expect(res.statusCode).toBe(200);
    expect(handlerCalls()).toEqual([name]);
    expect(h[name]).toHaveBeenCalledWith(event, 'user-123', params);
  });

  it('knows every handler it has, so a route added without a test here is noticed', () => {
    expect(routes).toHaveLength(Object.keys(h).length);
    expect(new Set(routes.map(([, , name]) => name)).size).toBe(Object.keys(h).length);
  });

  it.each([
    ['an unknown path', 'GET', '/api/nope'],
    ['the removed demo endpoint', 'GET', '/api/test'],
    ['a known path with the wrong method', 'GET', '/api/pots/p1/archive'],
    ['a path with an extra segment', 'GET', '/api/categories/c1/extra'],
  ])('answers 404 for %s', async (_label, method, path) => {
    const res = await invoke(makeEvent({ method, path }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Endpoint not found' });
    expect(handlerCalls()).toEqual([]);
  });

  it('checks the token before it looks at the route', async () => {
    rejectToken();
    const res = await invoke(makeEvent({ method: 'GET', path: '/api/nope' }));
    expect(res.statusCode).toBe(401);
  });
});

describe('a handler that fails', () => {
  it('answers a JSON 500 with a generic message when the handler rejects', async () => {
    h.getPots.mockRejectedValue(new Error('dynamodb: secret table name exploded'));
    const res = await invoke(makeEvent({ path: '/api/pots' }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error' });
    expect(res.body).not.toContain('dynamodb');
    expect(res.headers).toEqual(SECURITY_HEADERS);
  });

  it('answers the same when the handler throws before returning a promise', async () => {
    h.getPots.mockImplementation(() => { throw new Error('sync boom'); });
    const res = await invoke(makeEvent({ path: '/api/pots' }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('sync boom');
  });

  it('is never reported as an authentication failure', async () => {
    h.getPots.mockRejectedValue(new Error('boom'));
    const res = await invoke(makeEvent({ path: '/api/pots' }));
    expect(res.statusCode).not.toBe(401);
    expect(res.body).not.toContain('Unauthorized');
  });

  it('records what failed, for the logs, without the token', async () => {
    h.getPots.mockRejectedValue(new Error('boom detail'));
    await invoke(makeEvent({ path: '/api/pots' }));
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('boom detail');
    expect(logged).toContain('GET /templated');
    expect(logged).not.toContain(TOKEN);
  });
});

describe('store start-up', () => {
  it('starts the store once for an authenticated request', async () => {
    await invoke(makeEvent());
    expect(mockInitStore).toHaveBeenCalledTimes(1);
  });

  it('answers 500 without leaking detail when the store cannot start, and reaches no handler', async () => {
    mockInitStore.mockRejectedValueOnce(new Error('DYNAMODB_TABLE is required when STORE=dynamodb'));
    const res = await invoke(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error' });
    expect(res.body).not.toContain('DYNAMODB_TABLE');
    expect(handlerCalls()).toEqual([]);
  });
});

describe('public OAuth routes (R2)', () => {
  const PATHS: Array<[string, string]> = [
    ['GET', '/.well-known/oauth-protected-resource'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['POST', '/api/oauth/register'],
  ];

  afterEach(() => {
    delete process.env.APP_ORIGIN;
  });

  function bearerEvent(method: string, path: string): APIGatewayProxyEventV2 {
    const event = makeEvent({ method, path, authorization: 'Bearer hwr_not_a_real_token' });
    return { ...event, body: JSON.stringify({ redirect_uris: ['https://claude.ai/cb'] }) } as APIGatewayProxyEventV2;
  }

  it.each(PATHS)('answers %s %s without touching the auth provider, even with a Bearer hwr_ header', async (method, path) => {
    process.env.APP_ORIGIN = 'https://hoard.example';
    mockInitStore.mockRejectedValue(new Error('store must not be needed for discovery'));
    const res = await invoke(bearerEvent(method, path));
    expect(res.statusCode).not.toBe(401);
    // Registration needs the store, which is made to fail here; the point is that auth is never consulted.
    if (method === 'GET') expect(res.statusCode).toBe(200);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockGetSigningKey).not.toHaveBeenCalled();
    expect(handlerCalls()).toEqual([]);
  });

  it.each(PATHS)('answers %s %s with 404 and touches neither auth nor the store when no origin is set', async (method, path) => {
    delete process.env.APP_ORIGIN;
    const res = await invoke(bearerEvent(method, path));
    expect(res.statusCode).toBe(404);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockGetSigningKey).not.toHaveBeenCalled();
    expect(mockInitStore).not.toHaveBeenCalled();
  });

  it('serves discovery with 200 when the store throws on init', async () => {
    process.env.APP_ORIGIN = 'https://hoard.example';
    mockInitStore.mockRejectedValue(new Error('down'));
    const res = await invoke(makeEvent({ path: '/.well-known/oauth-protected-resource', authorization: null }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).resource).toBe('https://hoard.example/mcp');
  });
});
