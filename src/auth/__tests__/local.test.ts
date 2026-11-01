import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { resetTestStore, useTestStore } from '../../store/testing';
import type { SqliteStore } from '../../store/sqlite';
import { createAccount, createSession, readSession, recordFailure, throttleRemaining } from '../localData';
import { createLocalProvider } from '../local';
import { createToken, findToken, listTokens } from '../tokens';
import { initAuth, setAuth } from '..';
import { handler } from '../../../api-handler';

let store: SqliteStore;
const now = () => Math.floor(Date.now() / 1000);

function event(over: { method?: string; cookie?: string; origin?: string } = {}): APIGatewayProxyEventV2 {
  return {
    rawPath: '/api/categories',
    headers: { host: 'budget.example.com', ...(over.origin ? { origin: over.origin } : {}) },
    cookies: over.cookie ? [over.cookie] : undefined,
    requestContext: { routeKey: 'GET /x', http: { method: over.method ?? 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => {
  store = useTestStore();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  resetTestStore();
  setAuth(undefined);
  vi.restoreAllMocks();
});

describe('createLocalProvider', () => {
  it('logs the setup code exactly once when there is no account, and never when there is', async () => {
    const log = vi.mocked(console.log);
    await createLocalProvider({ STORE: 'sqlite', SQLITE_PATH: ':memory:' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/setup code/i);

    log.mockClear();
    await createAccount(store, 'me@example.com', 'a long enough password');
    await createLocalProvider({ STORE: 'sqlite', SQLITE_PATH: ':memory:' });
    expect(log).not.toHaveBeenCalled();
  });

  it('authenticates a live session cookie', async () => {
    const provider = await createLocalProvider({});
    const token = await createSession(store, 'local|u1', now());
    expect(await provider.authenticate(event({ cookie: `__Host-hoardwise_session=${token}` }))).toEqual({ userId: 'local|u1' });
  });

  it.each([
    ['no cookie', undefined],
    ['an unknown cookie', '__Host-hoardwise_session=bogus'],
  ])('answers 401 for %s', async (_label, cookie) => {
    const provider = await createLocalProvider({});
    const result = await provider.authenticate(event({ cookie }));
    expect('rejection' in result && result.rejection.statusCode).toBe(401);
  });

  it('answers 403 for a state-changing request from another origin, even with a valid cookie', async () => {
    const provider = await createLocalProvider({});
    const token = await createSession(store, 'local|u1', now());
    const result = await provider.authenticate(event({ method: 'DELETE', cookie: `__Host-hoardwise_session=${token}`, origin: 'https://evil.example.com' }));
    expect('rejection' in result && result.rejection.statusCode).toBe(403);
  });

  it('refuses a POST to the OAuth consent routes without an Origin header, at handler level', async () => {
    setAuth(await createLocalProvider({}));
    const token = await createSession(store, 'local|u1', now());
    const send = (method: string, path: string) => handler({
      rawPath: path,
      headers: { host: 'budget.example.com' },
      cookies: [`__Host-hoardwise_session=${token}`],
      body: '{}',
      requestContext: { routeKey: 'ANY /api/{proxy+}', http: { method, sourceIp: '198.51.100.9' } },
    } as unknown as APIGatewayProxyEventV2, {} as never, () => {}) as Promise<{ statusCode: number }>;
    expect((await send('POST', '/api/oauth/authorize')).statusCode).toBe(403);
    // GET is a safe method, so the provider's Origin check does not apply to it; the session still does.
    expect((await send('GET', '/api/oauth/client')).statusCode).not.toBe(403);
  });

  it('ignores a plain hoardwise_session cookie while cookies are Secure', async () => {
    const provider = await createLocalProvider({});
    const token = await createSession(store, 'local|u1', now());
    const result = await provider.authenticate(event({ cookie: `hoardwise_session=${token}` }));
    expect('rejection' in result && result.rejection.statusCode).toBe(401);
  });

  it('uses the plain name when COOKIE_SECURE=false', async () => {
    const provider = await createLocalProvider({ COOKIE_SECURE: 'false' });
    const token = await createSession(store, 'local|u1', now());
    expect(await provider.authenticate(event({ cookie: `hoardwise_session=${token}` }))).toEqual({ userId: 'local|u1' });
    const hosted = await provider.authenticate(event({ cookie: `__Host-hoardwise_session=${token}` }));
    expect('rejection' in hosted && hosted.rejection.statusCode).toBe(401);
  });

  it('checks Origin against APP_ORIGIN, not the Host header, for state-changing requests', async () => {
    const provider = await createLocalProvider({ APP_ORIGIN: 'https://budget.example.com' });
    const token = await createSession(store, 'local|u1', now());
    const cookie = `__Host-hoardwise_session=${token}`;
    const ok = await provider.authenticate(event({ method: 'DELETE', cookie, origin: 'https://budget.example.com' }));
    expect(ok).toEqual({ userId: 'local|u1' });
    const bad = await provider.authenticate(event({ method: 'DELETE', cookie, origin: 'https://budget.example.com.evil.test' }));
    expect('rejection' in bad && bad.rejection.statusCode).toBe(403);
  });

  it('is what initAuth loads for AUTH_MODE=local', async () => {
    const provider = await initAuth({ AUTH_MODE: 'local' });
    expect(typeof provider.handlePublic).toBe('function');
  });
});

function publicEvent(method: string, path: string, body?: unknown): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { host: 'budget.example.com', origin: 'https://budget.example.com' },
    requestContext: { routeKey: `${method} ${path}`, http: { method } },
  } as unknown as APIGatewayProxyEventV2;
}

const makeHooks = () => ({ announce: vi.fn(), retire: vi.fn() });

describe('createLocalProvider code hooks', () => {
  it('hands the first-run code to the hooks instead of logging it', async () => {
    const hooks = makeHooks();
    await createLocalProvider({}, { hooks });
    expect(hooks.announce).toHaveBeenCalledTimes(1);
    expect(hooks.announce).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9_-]{12}$/), 'setup');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('announces nothing when an account exists and recovery was not asked for', async () => {
    await createAccount(store, 'me@example.com', 'a long enough password');
    const hooks = makeHooks();
    await createLocalProvider({}, { hooks });
    expect(hooks.announce).not.toHaveBeenCalled();
  });

  it('opens recovery on an existing account: ends sessions, clears the lock-out, announces a recovery code', async () => {
    const account = await createAccount(store, 'me@example.com', 'a long enough password');
    const token = await createSession(store, account.userId, now());
    for (let i = 0; i < 5; i += 1) await recordFailure(store, now()); // the first 3 failures are free
    expect(await throttleRemaining(store, now())).toBeGreaterThan(0);
    const hooks = makeHooks();
    const provider = await createLocalProvider({}, { hooks, recovery: true });
    expect(hooks.announce).toHaveBeenCalledWith(expect.any(String), 'recovery');
    expect(await readSession(store, token, now())).toBeUndefined();
    expect(await throttleRemaining(store, now())).toBe(0);
    const status = await provider.handlePublic!(publicEvent('GET', '/api/auth/status'));
    expect(JSON.parse(status!.body)).toEqual({ setupRequired: false, recoveryOpen: true });
  });

  it('opening recovery revokes every access token', async () => {
    const account = await createAccount(store, 'me@example.com', 'a long enough password');

    const read = await createToken(store, { userId: account.userId, name: 'r', scope: 'read', expiryDays: null }, now());
    const write = await createToken(store, { userId: account.userId, name: 'w', scope: 'write', expiryDays: null }, now());
    await store.put({ PK: `USER#${account.userId}`, SK: 'CAT#c1', name: 'Garden' });
    await createLocalProvider({}, { hooks: makeHooks(), recovery: true });

    expect(await listTokens(store, account.userId)).toEqual([]);
    expect(await findToken(store, read.token, now())).toBeUndefined();
    expect(await findToken(store, write.token, now())).toBeUndefined();
    expect(await store.get({ PK: `USER#${account.userId}`, SK: 'CAT#c1' })).toBeDefined();
  });

  it('ignores a recovery request while no account exists and offers normal setup', async () => {
    const hooks = makeHooks();
    await createLocalProvider({}, { hooks, recovery: true });
    expect(hooks.announce).toHaveBeenCalledWith(expect.any(String), 'setup');
  });

  it('logs a recovery line when there are no hooks', async () => {
    await createAccount(store, 'me@example.com', 'a long enough password');
    await createLocalProvider({}, { recovery: true });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.log).mock.calls[0][0])).toMatch(/recovery code/i);
  });

  it('tells the hooks when the code is used', async () => {
    const hooks = makeHooks();
    const provider = await createLocalProvider({}, { hooks });
    const code = hooks.announce.mock.calls[0][0] as string;
    const res = await provider.handlePublic!(publicEvent('POST', '/api/auth/setup', { code, email: 'me@example.com', password: 'a perfectly fine password' }));
    expect(res?.statusCode).toBe(200);
    expect(hooks.retire).toHaveBeenCalledTimes(1);
  });
});
