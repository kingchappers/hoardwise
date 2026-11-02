import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { handler } from '../../../api-handler';
import { setAuth } from '../../auth';
import type { AuthProvider, AuthResult } from '../../auth';
import { sessionCookie } from '../../auth/cookies';
import { createLocalProvider } from '../../auth/local';
import { createSession } from '../../auth/localData';
import { createToken, listTokens, revokeToken } from '../../auth/tokens';
import type { TokenScope } from '../../auth/tokens';
import { setStore } from '../../store';
import { MemoryStore } from '../../store/memory';
import { SECURITY_HEADERS } from '../constants';
import { createRouter } from '../router';
import type { Router } from '../router';
import { registerCoreRoutes } from '../routes';
import { createTokenRouter } from '../tokenRouter';
import type { ApiResponse } from '../types';

const ROUTE_KEY = 'ANY /api/{proxy+}';
const TRANSACTION = { amount: 1250, type: 'EXPENSE', categoryId: 'groceries', description: 'Milk', date: '2026-10-15' };
const NOT_FOR_TOKENS = '{"error":"Not available to access tokens"}';

let store: MemoryStore;
let fakeAuth: {
  mode: 'auth0';
  authenticate: Mock<(event: APIGatewayProxyEventV2) => Promise<AuthResult>>;
  handlePublic: Mock<(event: APIGatewayProxyEventV2) => Promise<ApiResponse | undefined>>;
};
let warnSpy: ReturnType<typeof vi.spyOn>;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

interface EventOptions {
  method?: string;
  path?: string;
  authorization?: string;
  cookie?: string;
  origin?: string;
  body?: object;
  query?: Record<string, string>;
  sourceIp?: string;
}

function makeEvent(options: EventOptions = {}): APIGatewayProxyEventV2 {
  const { method = 'GET', path = '/api/categories', authorization, cookie, origin, body, query, sourceIp = nextIp() } = options;
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  if (cookie !== undefined) headers.cookie = cookie;
  if (origin !== undefined) headers.origin = origin;
  return {
    rawPath: path,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    queryStringParameters: query,
    requestContext: { routeKey: ROUTE_KEY, http: { method, sourceIp } },
  } as unknown as APIGatewayProxyEventV2;
}

async function invoke(event: APIGatewayProxyEventV2): Promise<ApiResponse> {
  return (await handler(event, {} as Context, () => {})) as ApiResponse;
}

async function tokenFor(userId: string, scope: TokenScope): Promise<string> {
  const { token } = await createToken(store, { userId, name: 'script', scope, expiryDays: 90 }, Math.floor(Date.now() / 1000));
  return token;
}

async function transactionsOf(userId: string): Promise<unknown[]> {
  return store.query(`USER#${userId}`, { skPrefix: 'TXN#' });
}

function listTransactions(authorization: string): APIGatewayProxyEventV2 {
  return makeEvent({ path: '/api/transactions', authorization, query: { year: '2026', month: '10' } });
}

function postTransaction(options: EventOptions): APIGatewayProxyEventV2 {
  return makeEvent({ method: 'POST', path: '/api/transactions', body: TRANSACTION, ...options });
}

async function useLocalMode(): Promise<AuthProvider> {
  const provider = await createLocalProvider({});
  setAuth(provider);
  return provider;
}

async function sessionCookieFor(userId: string): Promise<string> {
  const session = await createSession(store, userId, Math.floor(Date.now() / 1000));
  return sessionCookie(session, true).split(';')[0];
}

beforeEach(() => {
  store = new MemoryStore();
  setStore(store);
  fakeAuth = {
    mode: 'auth0',
    authenticate: vi.fn<(event: APIGatewayProxyEventV2) => Promise<AuthResult>>().mockResolvedValue({ userId: 'jwt-user' }),
    handlePublic: vi.fn<(event: APIGatewayProxyEventV2) => Promise<ApiResponse | undefined>>().mockResolvedValue(undefined),
  };
  setAuth(fakeAuth);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setAuth(undefined);
  setStore(undefined);
  vi.restoreAllMocks();
});

describe('read and write scopes', () => {
  it('a read token can list categories', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).categories.length).toBeGreaterThan(0);
  });

  it('a read token can HEAD categories and gets 200 with an empty body', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ method: 'HEAD', authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('a read token cannot HEAD the token list', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ method: 'HEAD', path: '/api/tokens', authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(403);
  });

  it('a read token cannot create a transaction', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(postTransaction({ authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('{"error":"This token is read-only"}');
    expect(await transactionsOf('user-a')).toEqual([]);
  });

  it('a write token can create a transaction', async () => {
    const token = await tokenFor('user-a', 'write');
    const res = await invoke(postTransaction({ authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(201);
    expect(await transactionsOf('user-a')).toHaveLength(1);
  });

  it("a token acts only on its owner's data", async () => {
    const tokenA = await tokenFor('user-a', 'write');
    const tokenB = await tokenFor('user-b', 'read');
    expect((await invoke(postTransaction({ authorization: `Bearer ${tokenA}` }))).statusCode).toBe(201);

    const res = await invoke(listTransactions(`Bearer ${tokenB}`));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).transactions).toEqual([]);
  });
});

describe('a token takes the place of every other credential', () => {
  it('a revoked token with a valid session cookie is refused', async () => {
    await useLocalMode();
    const created = await createToken(store, { userId: 'user-a', name: 'gone', scope: 'read', expiryDays: 90 }, Math.floor(Date.now() / 1000));
    await revokeToken(store, 'user-a', created.record.tokenId);
    const cookie = await sessionCookieFor('user-a');
    expect((await invoke(makeEvent({ cookie }))).statusCode).toBe(200);

    const res = await invoke(makeEvent({ authorization: `Bearer ${created.token}`, cookie }));
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('{"error":"Unauthorized"}');
  });

  it("a token with another user's session cookie acts as the token's owner", async () => {
    await useLocalMode();
    const token = await tokenFor('user-a', 'write');
    const cookie = await sessionCookieFor('user-b');
    expect((await invoke(postTransaction({ authorization: `Bearer ${token}`, cookie }))).statusCode).toBe(201);
    expect(await transactionsOf('user-a')).toHaveLength(1);
    expect(await transactionsOf('user-b')).toEqual([]);
  });

  it('a lower-case bearer scheme still makes it a token request, ahead of the session cookie', async () => {
    await useLocalMode();
    const token = await tokenFor('user-a', 'write');
    const cookie = await sessionCookieFor('user-b');
    expect((await invoke(postTransaction({ authorization: `bearer  ${token}`, cookie }))).statusCode).toBe(201);
    expect(await transactionsOf('user-a')).toHaveLength(1);
    expect(await transactionsOf('user-b')).toEqual([]);
  });

  it('a write token works on a POST with no Origin header', async () => {
    await useLocalMode();
    const cookie = await sessionCookieFor('user-a');
    expect((await invoke(postTransaction({ cookie }))).statusCode).toBe(403);

    const token = await tokenFor('user-a', 'write');
    const res = await invoke(postTransaction({ authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(201);
  });

  it('never consults the configured auth provider', async () => {
    const token = await tokenFor('user-a', 'read');
    await invoke(makeEvent({ authorization: `Bearer ${token}` }));
    await invoke(makeEvent({ authorization: `Bearer hwr_${'A'.repeat(43)}` }));
    expect(fakeAuth.authenticate).not.toHaveBeenCalled();
    expect(fakeAuth.handlePublic).not.toHaveBeenCalled();
  });
});

describe('account routes', () => {
  it.each(['read', 'write'] as const)('a token cannot reach /api/auth/me, /api/tokens or /api/push/subscriptions (%s)', async (scope) => {
    await useLocalMode();
    const token = await tokenFor('user-a', scope);
    const requests: Array<[string, string]> = [
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/logout'],
      ['GET', '/api/tokens'],
      ['POST', '/api/tokens'],
      ['DELETE', '/api/tokens/abc'],
      ['POST', '/api/push/subscriptions'],
      ['DELETE', '/api/push/subscriptions'],
    ];
    for (const [method, path] of requests) {
      const res = await invoke(makeEvent({ method, path, authorization: `Bearer ${token}` }));
      expect(res.statusCode, `${method} ${path}`).toBe(403);
      expect(res.body).toBe(NOT_FOR_TOKENS);
    }
  });

  it('logs a refusal with the templated route and the reason only', async () => {
    const token = await tokenFor('user-a', 'read');
    await invoke(makeEvent({ method: 'DELETE', path: '/api/transactions/2026-10/secret-id', authorization: `Bearer ${token}` }));
    await invoke(makeEvent({ method: 'GET', path: '/api/tokens/secret-id', authorization: `Bearer ${token}` }));
    expect(warnSpy).toHaveBeenCalledWith('Token access refused:', ROUTE_KEY, 'read-only');
    expect(warnSpy).toHaveBeenCalledWith('Token access refused:', ROUTE_KEY, 'account-route');
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain('secret-id');
    expect(logged).not.toContain(token.slice(0, 8));
  });
});

describe('failed lookups', () => {
  it('the 31st failed lookup from one address is answered 429 with Retry-After', async () => {
    const sourceIp = nextIp();
    const unknown = `Bearer hwr_${'A'.repeat(43)}`;
    for (let i = 0; i < 30; i++) {
      expect((await invoke(makeEvent({ authorization: unknown, sourceIp }))).statusCode).toBe(401);
    }

    const res = await invoke(makeEvent({ authorization: unknown, sourceIp }));
    expect(res.statusCode).toBe(429);
    expect(res.body).toBe('{"error":"Too many requests"}');
    expect(res.headers).toEqual({ ...SECURITY_HEADERS, 'Retry-After': '60' });

    const good = await tokenFor('user-a', 'read');
    expect((await invoke(makeEvent({ authorization: `Bearer ${good}`, sourceIp: nextIp() }))).statusCode).toBe(200);
  });

  it('answers a blocked address without looking the token up', async () => {
    const sourceIp = nextIp();
    const unknown = `Bearer hwr_${'A'.repeat(43)}`;
    for (let i = 0; i < 31; i++) await invoke(makeEvent({ authorization: unknown, sourceIp }));
    const good = await tokenFor('user-a', 'read');
    const get = vi.spyOn(store, 'get');

    const res = await invoke(makeEvent({ authorization: `Bearer ${good}`, sourceIp }));
    expect(res.statusCode).toBe(429);
    expect(get).not.toHaveBeenCalled();
  });

  it('does not count refused requests that carry a valid token', async () => {
    const sourceIp = nextIp();
    const token = await tokenFor('user-a', 'read');
    for (let i = 0; i < 40; i++) {
      expect((await invoke(postTransaction({ authorization: `Bearer ${token}`, sourceIp }))).statusCode).toBe(403);
    }
    expect((await invoke(makeEvent({ authorization: `Bearer ${token}`, sourceIp }))).statusCode).toBe(200);
  });
});

describe('bookkeeping and errors', () => {
  it('records when a token was last used', async () => {
    const token = await tokenFor('user-a', 'read');
    await invoke(makeEvent({ authorization: `Bearer ${token}` }));
    const [record] = await listTokens(store, 'user-a');
    expect(record.lastUsedAt).not.toBeNull();
  });

  it('answers the request when the last-used update fails', async () => {
    const token = await tokenFor('user-a', 'read');
    vi.spyOn(store, 'patch').mockRejectedValue(Object.assign(new Error(`boom ${token}`), { name: 'ConditionFailedError' }));
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith('Token last-used update failed:', 'ConditionFailedError');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(token);
  });

  it('answers a generic 500 when the lookup itself fails', async () => {
    const token = await tokenFor('user-a', 'read');
    vi.spyOn(store, 'get').mockRejectedValue(new Error('store down'));
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe('{"error":"Internal server error"}');
  });
});

describe('requests without a token', () => {
  it('a request without a token behaves exactly as before', async () => {
    const get = vi.spyOn(store, 'get');
    const res = await invoke(makeEvent({ authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig' }));
    expect(res.statusCode).toBe(200);
    expect(fakeAuth.handlePublic).toHaveBeenCalledTimes(1);
    expect(fakeAuth.authenticate).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.filter(([key]) => key.PK === 'AUTH#TOKENS')).toEqual([]);
  });
});

describe('route table', () => {
  it('a token cannot reach a route registered only on the main router', async () => {
    const extra = vi.fn().mockResolvedValue({ statusCode: 200, headers: SECURITY_HEADERS, body: '{}' });
    const main = createRouter();
    registerCoreRoutes(main);
    main.get('/api/settings/export', extra);
    const event = makeEvent({ path: '/api/settings/export' });

    expect((await main.dispatch(event, 'user-a')).statusCode).toBe(200);
    expect((await createTokenRouter().dispatch(event, 'user-a')).statusCode).toBe(404);
    expect(extra).toHaveBeenCalledTimes(1);
  });

  it('every GET route a token can reach is on the reviewed list', () => {
    const recorded: Array<{ method: string; path: string }> = [];
    const record = (method: string) => (path: string): void => { recorded.push({ method, path }); };
    const router: Router = {
      get: record('GET'),
      post: record('POST'),
      put: record('PUT'),
      delete: record('DELETE'),
      dispatch: () => Promise.reject(new Error('not used')),
      routes: () => [],
    };
    createTokenRouter(router);

    const getPaths = recorded.filter(r => r.method === 'GET').map(r => r.path).sort();
    // Adding a GET route? Confirm it has no side effects (a read token may call it), then add it here.
    expect(getPaths).toEqual([
      '/api/accounts',
      '/api/categories',
      '/api/docs/agents',
      '/api/expected-income',
      '/api/openapi.json',
      '/api/pots',
      '/api/recurring',
      '/api/targets',
      '/api/transactions',
      '/api/transactions/range',
      '/api/trash',
    ]);
  });
});
