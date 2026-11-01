import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { resetTestStore, useTestStore } from '../../store/testing';
import type { SqliteStore } from '../../store/sqlite';
import { handleAuthRoute } from '../routes';
import type { AuthRouteContext } from '../routes';
import { SetupCode } from '../setupCode';
import { createToken, findToken, listTokens } from '../tokens';
import { createAccount, createSession, hashToken, getAccount, readSession, recordFailure, throttleRemaining } from '../localData';

const PASSWORD = 'a perfectly fine password';
let store: SqliteStore;
let setupCode: SetupCode;
let now: number;
let ctx: AuthRouteContext;

function post(path: string, body: unknown, over: { cookie?: string; origin?: string | null } = {}): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = { host: 'budget.example.com' };
  if (over.origin !== null) headers.origin = over.origin ?? 'https://budget.example.com';
  return {
    rawPath: path,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
    cookies: over.cookie ? [over.cookie] : undefined,
    requestContext: { routeKey: `POST ${path}`, http: { method: 'POST', sourceIp: '203.0.113.9' } },
  } as unknown as APIGatewayProxyEventV2;
}

function get(path: string, cookie?: string): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    headers: { host: 'budget.example.com' },
    cookies: cookie ? [cookie] : undefined,
    requestContext: { routeKey: `GET ${path}`, http: { method: 'GET', sourceIp: '203.0.113.9' } },
  } as unknown as APIGatewayProxyEventV2;
}

function cookieValue(res: { cookies?: string[] } | undefined): string {
  return (res?.cookies?.[0] ?? '').split(';')[0];
}

beforeEach(() => {
  store = useTestStore();
  setupCode = SetupCode.generate();
  now = 1_800_000_000;
  ctx = { store, setupCode, secureCookie: true, nowSeconds: () => now };
});
afterEach(() => {
  resetTestStore();
  vi.restoreAllMocks();
});

const setupBody = (over: Record<string, unknown> = {}) => ({ code: setupCode.reveal(), email: 'Me@Example.com', password: PASSWORD, ...over });

describe('routes that do not belong to auth', () => {
  it('returns undefined, so the normal pipeline handles them', async () => {
    expect(await handleAuthRoute(get('/api/categories'), ctx)).toBeUndefined();
    expect(await handleAuthRoute(get('/api/auth/nope'), ctx)).toBeUndefined();
  });
});

describe('GET /api/auth/status', () => {
  it('says setup is required until an account exists', async () => {
    expect(JSON.parse((await handleAuthRoute(get('/api/auth/status'), ctx))!.body)).toEqual({ setupRequired: true, recoveryOpen: false });
    await createAccount(store, 'me@example.com', PASSWORD);
    expect(JSON.parse((await handleAuthRoute(get('/api/auth/status'), ctx))!.body)).toEqual({ setupRequired: false, recoveryOpen: false });
  });
});

describe('POST /api/auth/setup', () => {
  it('creates the account, starts a session and sets a hardened cookie', async () => {
    const res = (await handleAuthRoute(post('/api/auth/setup', setupBody()), ctx))!;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ email: 'me@example.com' });
    expect(res.cookies![0]).toMatch(/HttpOnly.*SameSite=Strict/);
    expect((await getAccount(store))?.email).toBe('me@example.com');
  });

  it('refuses a wrong code and creates nothing', async () => {
    const res = (await handleAuthRoute(post('/api/auth/setup', setupBody({ code: 'wrong' })), ctx))!;
    expect(res.statusCode).toBe(403);
    expect(await getAccount(store)).toBeUndefined();
  });

  it('is closed for good once an account exists', async () => {
    const secondAttempt = setupBody({ email: 'x@example.com' });
    await handleAuthRoute(post('/api/auth/setup', setupBody()), ctx);
    const again = (await handleAuthRoute(post('/api/auth/setup', secondAttempt), ctx))!;
    expect(again.statusCode).toBe(409);
    expect((await getAccount(store))?.email).toBe('me@example.com');
  });

  it('makes exactly one account when two setups race', async () => {
    const [a, b] = await Promise.all([
      handleAuthRoute(post('/api/auth/setup', setupBody({ email: 'a@example.com' })), ctx),
      handleAuthRoute(post('/api/auth/setup', setupBody({ email: 'b@example.com' })), ctx),
    ]);
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([200, 409]);
  });

  it.each([
    ['a short password', { password: 'short' }],
    ['a 10,000-character password', { password: 'x'.repeat(10_000) }],
    ['a missing email', { email: undefined }],
    ['an invalid email', { email: 'not-an-email' }],
    ['a 300-character email', { email: `${'a'.repeat(300)}@example.com` }],
  ])('rejects %s with 400 and creates nothing', async (_label, over) => {
    const res = (await handleAuthRoute(post('/api/auth/setup', setupBody(over)), ctx))!;
    expect(res.statusCode).toBe(400);
    expect(await getAccount(store)).toBeUndefined();
  });

  it('rejects a body that is not a JSON object', async () => {
    expect((await handleAuthRoute(post('/api/auth/setup', '[1,2]'), ctx))!.statusCode).toBe(400);
    expect((await handleAuthRoute(post('/api/auth/setup', '{oops'), ctx))!.statusCode).toBe(400);
  });

  it('refuses a request from another origin, or with none', async () => {
    expect((await handleAuthRoute(post('/api/auth/setup', setupBody(), { origin: 'https://evil.example.com' }), ctx))!.statusCode).toBe(403);
    expect((await handleAuthRoute(post('/api/auth/setup', setupBody(), { origin: null }), ctx))!.statusCode).toBe(403);
    expect(await getAccount(store)).toBeUndefined();
  });

  it('discards the setup code after use', async () => {
    const code = setupCode.reveal();
    await handleAuthRoute(post('/api/auth/setup', setupBody()), ctx);
    expect(setupCode.matches(code)).toBe(false);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await createAccount(store, 'me@example.com', PASSWORD);
  });

  it('signs in with the right credentials, whatever the email case or spacing', async () => {
    const res = (await handleAuthRoute(post('/api/auth/login', { email: '  ME@example.com ', password: PASSWORD }), ctx))!;
    expect(res.statusCode).toBe(200);
    expect(cookieValue(res)).toMatch(/^__Host-hoardwise_session=.+/);
  });

  it('answers a wrong password and an unknown email identically', async () => {
    const wrongPassword = (await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: 'not the password' }), ctx))!;
    const wrongEmail = (await handleAuthRoute(post('/api/auth/login', { email: 'who@example.com', password: PASSWORD }), ctx))!;
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongEmail.statusCode).toBe(401);
    expect(wrongPassword.body).toBe(wrongEmail.body);
    expect(wrongPassword.cookies).toBeUndefined();
  });

  it('refuses an over-long password without hashing it', async () => {
    const res = (await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: 'x'.repeat(10_000) }), ctx))!;
    expect(res.statusCode).toBe(401);
  });

  it('throttles after repeated failures, even for the right password, then recovers', async () => {
    for (let i = 0; i < 4; i++) {
      await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: 'wrong wrong wrong' }), ctx);
    }
    const blocked = (await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: PASSWORD }), ctx))!;
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['Retry-After']).toBe('1');

    now += 1;
    const recovered = (await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: PASSWORD }), ctx))!;
    expect(recovered.statusCode).toBe(200);
  });

  it('treats a stored record that cannot be verified as a failed login, not a 500, and logs a fixed message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await store.patch({ PK: 'AUTH#ACCOUNT', SK: 'PROFILE' }, { N: 3 }, { mustExist: true });
    const res = (await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: PASSWORD }), ctx))!;
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toBeUndefined();
    expect(error).toHaveBeenCalledWith('Stored account password record could not be verified:', expect.any(String));
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('me@example.com');
  });

  it('does not deadlock later logins after the corrupt-record path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const key = { PK: 'AUTH#ACCOUNT', SK: 'PROFILE' };
    await store.patch(key, { N: 3 }, { mustExist: true });
    await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: PASSWORD }), ctx);
    await store.patch(key, { N: 2 ** 15 }, { mustExist: true });
    const res = (await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: PASSWORD }), ctx))!;
    expect(res.statusCode).toBe(200);
  });

  it('holds the throttle under a burst of simultaneous wrong passwords', async () => {
    const burst = await Promise.all(
      Array.from({ length: 8 }, () => handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: 'wrong wrong wrong' }), ctx)),
    );
    const codes = burst.map(res => res!.statusCode);
    expect(codes.filter(code => code === 429).length).toBeGreaterThanOrEqual(1);
    expect(codes.filter(code => code === 401).length).toBeLessThanOrEqual(4);
    expect(await throttleRemaining(store, now)).toBeGreaterThan(0);
  });

  it('refuses a 255-character email as a failed login', async () => {
    const email = `${'a'.repeat(243)}@example.com`;
    expect(email.length).toBe(255);
    const res = (await handleAuthRoute(post('/api/auth/login', { email, password: PASSWORD }), ctx))!;
    expect(res.statusCode).toBe(401);
    expect(await store.get({ PK: 'AUTH#THROTTLE', SK: 'LOGIN' })).toMatchObject({ failures: 1 });
  });

  it('refuses a request from another origin', async () => {
    const res = (await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: PASSWORD }, { origin: 'https://evil.example.com' }), ctx))!;
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/auth/me and POST /api/auth/logout', () => {
  async function signIn(): Promise<string> {
    await createAccount(store, 'me@example.com', PASSWORD);
    const res = await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: PASSWORD }), ctx);
    return cookieValue(res);
  }

  it('says who is signed in', async () => {
    const cookie = await signIn();
    const res = (await handleAuthRoute(get('/api/auth/me', cookie), ctx))!;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ email: 'me@example.com', userId: expect.stringMatching(/^local\|/) });
  });

  it('answers 401 with no cookie or an unknown one', async () => {
    await signIn();
    expect((await handleAuthRoute(get('/api/auth/me'), ctx))!.statusCode).toBe(401);
    expect((await handleAuthRoute(get('/api/auth/me', '__Host-hoardwise_session=bogus'), ctx))!.statusCode).toBe(401);
  });

  it('ends the session on logout and clears the cookie', async () => {
    const cookie = await signIn();
    const out = (await handleAuthRoute(post('/api/auth/logout', {}, { cookie }), ctx))!;
    expect(out.cookies![0]).toContain('Max-Age=0');
    expect((await handleAuthRoute(get('/api/auth/me', cookie), ctx))!.statusCode).toBe(401);
  });

  it('keeps the session when logout comes from another origin', async () => {
    const cookie = await signIn();
    const res = (await handleAuthRoute(post('/api/auth/logout', {}, { cookie, origin: 'https://evil.example.com' }), ctx))!;
    expect(res.statusCode).toBe(403);
    expect((await handleAuthRoute(get('/api/auth/me', cookie), ctx))!.statusCode).toBe(200);
  });

  it('answers 401 once the session has expired', async () => {
    const cookie = await signIn();
    now += 31 * 24 * 60 * 60;
    expect((await handleAuthRoute(get('/api/auth/me', cookie), ctx))!.statusCode).toBe(401);
  });
});

describe('what reaches the logs and the database', () => {
  it('never logs the password, the cookie or the setup code', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}));
    const secretPassword = 'the-secret-password-123';
    const code = setupCode.reveal();
    const setup = (await handleAuthRoute(post('/api/auth/setup', setupBody({ password: secretPassword })), ctx))!;
    await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: 'wrong wrong wrong' }), ctx);
    await handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password: secretPassword }), ctx);

    const logged = JSON.stringify(spies.flatMap(spy => spy.mock.calls));
    expect(logged).not.toContain(secretPassword);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(cookieValue(setup).split('=')[1]);
    expect(logged).not.toContain(cookieValue(setup));
  });

  it('stores only the hash of the cookie value', async () => {
    const res = (await handleAuthRoute(post('/api/auth/setup', setupBody()), ctx))!;
    const token = cookieValue(res).split('=')[1];
    const rows = await store.query('AUTH#SESSIONS');
    expect(rows.map(row => row.SK)).toContain(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe('password recovery', () => {
  const NEW_PASSWORD = 'another perfectly fine password';
  const recoveryBody = (over: Record<string, unknown> = {}) => ({ code: setupCode.reveal(), password: NEW_PASSWORD, ...over });
  const login = (password: string) => handleAuthRoute(post('/api/auth/login', { email: 'me@example.com', password }), ctx);

  async function openRecovery() {
    const account = await createAccount(store, 'me@example.com', PASSWORD);
    const oldToken = await createSession(store, account.userId, now);
    ctx.recovery = true;
    return { account, oldToken };
  }

  it('reports recoveryOpen in the status only while recovery is open', async () => {
    await createAccount(store, 'me@example.com', PASSWORD);
    expect(JSON.parse((await handleAuthRoute(get('/api/auth/status'), ctx))!.body)).toEqual({ setupRequired: false, recoveryOpen: false });
    ctx.recovery = true;
    expect(JSON.parse((await handleAuthRoute(get('/api/auth/status'), ctx))!.body)).toEqual({ setupRequired: false, recoveryOpen: true });
  });

  it('replaces the password on the existing account and signs the user in', async () => {
    const { account } = await openRecovery();
    const res = await handleAuthRoute(post('/api/auth/setup', recoveryBody()), ctx);
    expect(res?.statusCode).toBe(200);
    expect(JSON.parse(res!.body)).toEqual({ userId: account.userId, email: 'me@example.com' });
    expect(cookieValue(res)).toMatch(/^__Host-hoardwise_session=/);
    expect((await login(NEW_PASSWORD))?.statusCode).toBe(200);
    expect((await login(PASSWORD))?.statusCode).toBe(401);
  });

  it('does not replace the password when the tokens cannot all be revoked', async () => {
    await openRecovery();
    const realQuery = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (pk, ...rest) =>
      pk === 'AUTH#TOKENS' ? [{ PK: pk, SK: 'stuck', userId: 'u' }] : realQuery(pk, ...rest));
    await expect(handleAuthRoute(post('/api/auth/setup', recoveryBody()), ctx)).rejects.toThrow('Could not revoke every access token');
    vi.restoreAllMocks();
    expect(ctx.recovery).toBe(false);
    expect((await login(PASSWORD))?.statusCode).toBe(200);
    expect((await login(NEW_PASSWORD))?.statusCode).toBe(401);
  });

  it('completing a recovery revokes every access token', async () => {
    const { account } = await openRecovery();

    const read = await createToken(store, { userId: account.userId, name: 'r', scope: 'read', expiryDays: null }, now);
    const write = await createToken(store, { userId: account.userId, name: 'w', scope: 'write', expiryDays: null }, now);
    await store.put({ PK: `USER#${account.userId}`, SK: 'CAT#c1', name: 'Garden' });
    await handleAuthRoute(post('/api/auth/setup', recoveryBody()), ctx);

    expect(await listTokens(store, account.userId)).toEqual([]);
    expect(await findToken(store, read.token, now)).toBeUndefined();
    expect(await findToken(store, write.token, now)).toBeUndefined();
    expect(await store.get({ PK: `USER#${account.userId}`, SK: 'CAT#c1' })).toBeDefined();
  });

  it('keeps the same account: user id and email are unchanged', async () => {
    const { account } = await openRecovery();
    await handleAuthRoute(post('/api/auth/setup', recoveryBody()), ctx);
    const after = await getAccount(store);
    expect(after?.userId).toBe(account.userId);
    expect(after?.email).toBe(account.email);
  });

  it('ends every earlier session and clears the login lock-out when it completes', async () => {
    const { oldToken } = await openRecovery();
    for (let i = 0; i < 5; i += 1) await recordFailure(store, now); // the first 3 failures are free
    expect(await throttleRemaining(store, now)).toBeGreaterThan(0);
    await handleAuthRoute(post('/api/auth/setup', recoveryBody()), ctx);
    expect(await readSession(store, oldToken, now)).toBeUndefined();
    expect(await throttleRemaining(store, now)).toBe(0);
  });

  it('closes recovery once used, and the code cannot be used twice', async () => {
    await openRecovery();
    const body = recoveryBody();
    expect((await handleAuthRoute(post('/api/auth/setup', body), ctx))?.statusCode).toBe(200);
    expect(ctx.recovery).toBe(false);
    expect((await handleAuthRoute(post('/api/auth/setup', body), ctx))?.statusCode).toBe(409);
  });

  it('lets only one of two simultaneous requests use the code', async () => {
    await openRecovery();
    const body = recoveryBody();
    const results = await Promise.all([
      handleAuthRoute(post('/api/auth/setup', body), ctx),
      handleAuthRoute(post('/api/auth/setup', body), ctx),
    ]);
    const codes = results.map(result => result?.statusCode);
    expect(codes.filter(code => code === 200)).toHaveLength(1);
    // The loser is refused: 403 (code already spent) or 409 (recovery already closed), depending on interleaving.
    expect(codes.filter(code => code === 403 || code === 409)).toHaveLength(1);
  });

  it('refuses a wrong code and leaves the password and the code alone', async () => {
    await openRecovery();
    const res = await handleAuthRoute(post('/api/auth/setup', recoveryBody({ code: 'not the code' })), ctx);
    expect(res?.statusCode).toBe(403);
    expect(JSON.parse(res!.body)).toEqual({ error: 'Invalid recovery code' });
    expect(ctx.recovery).toBe(true);
    expect((await login(PASSWORD))?.statusCode).toBe(200);
  });

  it('enforces the password policy and keeps recovery open', async () => {
    await openRecovery();
    const res = await handleAuthRoute(post('/api/auth/setup', recoveryBody({ password: 'short' })), ctx);
    expect(res?.statusCode).toBe(400);
    expect(ctx.recovery).toBe(true);
    expect((await handleAuthRoute(post('/api/auth/setup', recoveryBody()), ctx))?.statusCode).toBe(200);
  });

  it('still answers 409 for an existing account when recovery is not open', async () => {
    await createAccount(store, 'me@example.com', PASSWORD);
    const res = await handleAuthRoute(post('/api/auth/setup', recoveryBody()), ctx);
    expect(res?.statusCode).toBe(409);
  });

  it('refuses a recovery request with no code', async () => {
    await openRecovery();
    const { code: _code, ...withoutCode } = recoveryBody();
    expect((await handleAuthRoute(post('/api/auth/setup', withoutCode), ctx))?.statusCode).toBe(403);
  });

  it('refuses a recovery request when there is no setup code to match', async () => {
    await openRecovery();
    ctx.setupCode = undefined;
    expect((await handleAuthRoute(post('/api/auth/setup', recoveryBody()), ctx))?.statusCode).toBe(403);
  });

  describe.each([['login first', true], ['recovery first', false]])('a login on the old password racing recovery (%s)', (_name, loginFirst) => {
    it('leaves no valid session on the old password', async () => {
      await openRecovery();
      const startLogin = () => login(PASSWORD);
      const startRecovery = () => handleAuthRoute(post('/api/auth/setup', recoveryBody()), ctx);
      const [first, second] = await Promise.all(loginFirst ? [startLogin(), startRecovery()] : [startRecovery(), startLogin()]);
      const loginRes = loginFirst ? first : second;
      const recoveryRes = loginFirst ? second : first;

      expect(recoveryRes?.statusCode).toBe(200);
      if (loginRes?.statusCode === 200) {
        const token = cookieValue(loginRes).split('=')[1];
        expect(await readSession(store, token, now)).toBeUndefined();
        return;
      }
      expect(loginRes?.statusCode).toBe(401);
    });
  });

  it('tells the host when the recovery code is spent', async () => {
    await openRecovery();
    const onCodeUsed = vi.fn();
    ctx.onCodeUsed = onCodeUsed;
    expect((await handleAuthRoute(post('/api/auth/setup', recoveryBody()), ctx))?.statusCode).toBe(200);
    expect(onCodeUsed).toHaveBeenCalledTimes(1);
  });

  it('tells the host when a first-run setup code is used', async () => {
    const onCodeUsed = vi.fn();
    ctx.onCodeUsed = onCodeUsed;
    expect((await handleAuthRoute(post('/api/auth/setup', setupBody()), ctx))?.statusCode).toBe(200);
    expect(onCodeUsed).toHaveBeenCalledTimes(1);
  });
});
