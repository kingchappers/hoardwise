import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { handler } from '../../../api-handler';
import { setAuth } from '../../auth';
import type { AuthMode, AuthProvider, AuthResult } from '../../auth';
import { createAccount, recordFailure } from '../../auth/localData';
import { createToken } from '../../auth/tokens';
import { consumeCode } from '../../oauth/codes';
import { getClient, registerClient } from '../../oauth/clients';
import { UNUSED_CLIENT_TTL_SECONDS, USED_CLIENT_TTL_SECONDS } from '../../oauth/types';
import { setStore } from '../../store';
import { MemoryStore } from '../../store/memory';
import { authorizeOauthClient, getOauthClient } from '../oauthConsent';
import type { ApiResponse } from '../types';

const PASSWORD = 'correct horse battery staple';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const ORIGIN = 'https://hoard.example';

let store: MemoryStore;
let logSpy: MockInstance<typeof console.log>;
let clientId: string;
let savedOrigin: string | undefined;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function event(method: string, path: string, options: { body?: unknown; raw?: string; query?: Record<string, string> } = {}): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    headers: {},
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    queryStringParameters: options.query,
    requestContext: { routeKey: 'ANY /api/{proxy+}', http: { method, sourceIp: '198.51.100.1' } },
  } as unknown as APIGatewayProxyEventV2;
}

function authorize(body: unknown, userId = 'user-a'): Promise<ApiResponse> {
  return authorizeOauthClient(event('POST', '/api/oauth/authorize', { body }), userId, {});
}

function describeClient(query: Record<string, string>): Promise<ApiResponse> {
  return getOauthClient(event('GET', '/api/oauth/client', { query }), 'user-a', {});
}

function valid(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { client_id: clientId, redirect_uri: REDIRECT, scope: 'read', code_challenge: CHALLENGE, ...extra };
}

function fakeProvider(mode: AuthMode): AuthProvider {
  return {
    mode,
    authenticate: vi.fn<(event: APIGatewayProxyEventV2) => Promise<AuthResult>>().mockResolvedValue({ userId: 'user-a' }),
  };
}

async function useLocalModeWithAccount(): Promise<void> {
  setAuth(fakeProvider('local'));
  await createAccount(store, 'owner@example.com', PASSWORD);
}

function codeFrom(res: ApiResponse): string {
  return new URL(JSON.parse(res.body).redirectTo).searchParams.get('code') ?? '';
}

beforeEach(async () => {
  store = new MemoryStore();
  setStore(store);
  setAuth(fakeProvider('auth0'));
  savedOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  clientId = (await registerClient(store, { name: 'Claude', redirectUris: [REDIRECT] }, now())).clientId;
});

afterEach(() => {
  if (savedOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = savedOrigin;
  setAuth(undefined);
  setStore(undefined);
  vi.restoreAllMocks();
});

describe('GET /api/oauth/client', () => {
  it('describes a registered client and redirect', async () => {
    const res = await describeClient({ client_id: clientId, redirect_uri: REDIRECT });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ name: 'Claude', redirectHost: 'claude.ai', redirectUri: REDIRECT });
    expect(res.headers?.['Cache-Control']).toBe('no-store');
  });

  it.each([
    ['an unknown client', () => ({ client_id: 'nope', redirect_uri: REDIRECT })],
    ['an unregistered redirect', () => ({ client_id: clientId, redirect_uri: 'https://evil.example/cb' })],
    ['a redirect that differs by a trailing slash', () => ({ client_id: clientId, redirect_uri: `${REDIRECT}/` })],
    ['missing parameters', () => ({})],
  ])('answers a generic 404 for %s', async (_name, query) => {
    const res = await describeClient(query());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
  });

  it('answers 404 when OAuth is not configured', async () => {
    delete process.env.APP_ORIGIN;
    expect((await describeClient({ client_id: clientId, redirect_uri: REDIRECT })).statusCode).toBe(404);
  });
});

describe('POST /api/oauth/authorize', () => {
  it('returns the registered redirect with a code bound to the signed-in user', async () => {
    const res = await authorize(valid({ state: 'abc 123&x=y' }), 'user-b');
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Cache-Control']).toBe('no-store');
    const target = new URL(JSON.parse(res.body).redirectTo);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get('state')).toBe('abc 123&x=y');
    const stored = await consumeCode(store, codeFrom(res), now());
    expect(stored).toEqual({ clientId, userId: 'user-b', scope: 'read', redirectUri: REDIRECT, codeChallenge: CHALLENGE });
  });

  it('omits state when none was supplied', async () => {
    const target = new URL(JSON.parse((await authorize(valid())).body).redirectTo);
    expect(target.searchParams.has('state')).toBe(false);
  });

  it('keeps an existing query on the registered redirect', async () => {
    const withQuery = (await registerClient(store, { name: 'Other', redirectUris: ['https://app.example/cb?tenant=1'] }, now())).clientId;
    const res = await authorize(valid({ client_id: withQuery, redirect_uri: 'https://app.example/cb?tenant=1' }));
    const target = new URL(JSON.parse(res.body).redirectTo);
    expect(target.searchParams.get('tenant')).toBe('1');
    expect(target.searchParams.get('code')).toBeTruthy();
  });

  it('extends the client to the used lifetime on success only', async () => {
    await authorize(valid({ scope: 'admin' }));
    expect((await store.get({ PK: 'OAUTH#CLIENTS', SK: clientId }))?.usedAt).toBeUndefined();
    await authorize(valid());
    const row = await store.get({ PK: 'OAUTH#CLIENTS', SK: clientId });
    expect(row?.usedAt).toBeGreaterThan(0);
    expect(Number(row?.expiresAt) - Number(row?.usedAt)).toBe(USED_CLIENT_TTL_SECONDS);
    expect(USED_CLIENT_TTL_SECONDS).toBeGreaterThan(UNUSED_CLIENT_TTL_SECONDS);
    expect(await getClient(store, clientId, now())).toBeDefined();
  });

  it.each([
    ['an unregistered redirect_uri', { redirect_uri: 'https://evil.example/cb' }],
    ['a redirect_uri with a trailing slash', { redirect_uri: `${REDIRECT}/` }],
    ['an unknown client_id', { client_id: 'nope' }],
  ])('refuses %s without a redirectTo', async (_name, change) => {
    const res = await authorize(valid(change));
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('redirectTo');
    expect(await store.query('OAUTH#CODES')).toEqual([]);
  });

  it.each([
    ['an unknown scope', { scope: 'admin' }],
    ['a missing scope', { scope: undefined }],
    ['a missing challenge', { code_challenge: undefined }],
    ['a short challenge', { code_challenge: CHALLENGE.slice(1) }],
    ['a long challenge', { code_challenge: `${CHALLENGE}A` }],
    ['a challenge with characters outside base64url', { code_challenge: `${CHALLENGE.slice(1)}+` }],
    ['a method field', { code_challenge_method: 'S256' }],
    ['an unknown field', { extra: 1 }],
    ['a non-string state', { state: 5 }],
    ['an over-long state', { state: 's'.repeat(513) }],
    ['a non-string password', { password: 5 }],
    ['a missing client_id', { client_id: undefined }],
    ['a missing redirect_uri', { redirect_uri: undefined }],
  ])('rejects %s with 400', async (_name, change) => {
    const res = await authorize(valid(change));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('redirectTo');
  });

  it('accepts a state of exactly 512 characters', async () => {
    expect((await authorize(valid({ state: 's'.repeat(512) }))).statusCode).toBe(200);
  });

  it('rejects a body that is not a JSON object', async () => {
    const res = await authorizeOauthClient(event('POST', '/api/oauth/authorize', { raw: '[1]' }), 'user-a', {});
    expect(res.statusCode).toBe(400);
  });

  it('answers 404 when OAuth is not configured', async () => {
    delete process.env.APP_ORIGIN;
    expect((await authorize(valid())).statusCode).toBe(404);
  });

  it('never asks Auth0 mode for a password, even for write', async () => {
    expect((await authorize(valid({ scope: 'write' }))).statusCode).toBe(200);
  });

  it('logs the client and scope, never the code', async () => {
    const res = await authorize(valid({ scope: 'write' }));
    const text = logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(text).toContain(`OAuth consent granted: ${clientId} write`);
    expect(text).not.toContain(codeFrom(res));
  });
});

describe('local mode', () => {
  beforeEach(useLocalModeWithAccount);

  it('lets a read scope through without a password', async () => {
    expect((await authorize(valid())).statusCode).toBe(200);
  });

  it('refuses write without a password', async () => {
    const res = await authorize(valid({ scope: 'write' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Password required');
    expect(await store.query('OAUTH#CODES')).toEqual([]);
  });

  it('refuses write with a wrong password', async () => {
    const res = await authorize(valid({ scope: 'write', password: 'wrong' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Incorrect password');
    expect(await store.query('OAUTH#CODES')).toEqual([]);
  });

  it('issues a code for write with the right password', async () => {
    const res = await authorize(valid({ scope: 'write', password: PASSWORD }));
    expect(res.statusCode).toBe(200);
    expect((await consumeCode(store, codeFrom(res), now()))?.scope).toBe('write');
  });

  it('throttles with the shared password throttle', async () => {
    for (let i = 0; i < 5; i++) await recordFailure(store, now());
    const res = await authorize(valid({ scope: 'write', password: PASSWORD }));
    expect(res.statusCode).toBe(429);
    expect(res.headers?.['Retry-After']).toBeDefined();
  });

  it('does not touch the password for an unregistered redirect', async () => {
    const res = await authorize(valid({ scope: 'write', redirect_uri: 'https://evil.example/cb' }));
    expect(res.statusCode).toBe(404);
  });
});

describe('through the handler', () => {
  function request(method: string, path: string, authorization?: string, body?: unknown, query?: Record<string, string>): Promise<ApiResponse> {
    const e = event(method, path, { body, query });
    if (authorization) (e.headers as Record<string, string>).authorization = authorization;
    return handler(e, {} as Context, () => {}) as Promise<ApiResponse>;
  }

  it('is reachable by a signed-in session', async () => {
    const res = await request('POST', '/api/oauth/authorize', undefined, valid());
    expect(res.statusCode).toBe(200);
    expect((await request('GET', '/api/oauth/client', undefined, undefined, { client_id: clientId, redirect_uri: REDIRECT })).statusCode).toBe(200);
  });

  it('is 401 when not signed in', async () => {
    (setAuth as (p: AuthProvider) => void)({
      mode: 'auth0',
      authenticate: async () => ({ rejection: { statusCode: 401, headers: {}, body: '{"error":"Unauthorized"}' } }),
    });
    expect((await request('POST', '/api/oauth/authorize', undefined, valid())).statusCode).toBe(401);
    expect((await request('GET', '/api/oauth/client', undefined, undefined, { client_id: clientId, redirect_uri: REDIRECT })).statusCode).toBe(401);
  });

  it.each(['read', 'write'] as const)('is 403 for a %s access token', async (scope) => {
    const { token } = await createToken(store, { userId: 'user-a', name: 'x', scope, expiryDays: 90 }, now());
    const post = await request('POST', '/api/oauth/authorize', `Bearer ${token}`, valid());
    expect(post.statusCode).toBe(403);
    expect(post.body).toBe('{"error":"Not available to access tokens"}');
    const get = await request('GET', '/api/oauth/client', `Bearer ${token}`, undefined, { client_id: clientId, redirect_uri: REDIRECT });
    expect(get.statusCode).toBe(403);
    expect(await store.query('OAUTH#CODES')).toEqual([]);
  });

  it('still serves the public register route without credentials', async () => {
    const res = await request('POST', '/api/oauth/register', 'Bearer hwr_x', { redirect_uris: [REDIRECT] });
    expect(res.statusCode).toBe(201);
  });
});
