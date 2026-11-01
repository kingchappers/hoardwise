import { createHash } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory';
import { createFailureLimiter } from '../../auth/failureLimiter';
import { authenticateToken } from '../../auth/tokenAuth';
import { MAX_TOKENS_PER_USER, createToken, findToken, listTokens } from '../../auth/tokens';
import { registerClient } from '../clients';
import { issueCode } from '../codes';
import { rotateConnection } from '../connections';
import { handleOauthPublic } from '../routes';
import type { OauthPublicDeps } from '../routes';

const NOW = 1_800_000_000;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

let store: MemoryStore;
let deps: OauthPublicDeps;
let clientId: string;

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function call(
  path: 'token' | 'revoke',
  body: string,
  options: { ip?: string; method?: string; contentType?: string; base64?: boolean } = {},
): APIGatewayProxyEventV2 {
  const base64 = options.base64 ?? false;
  return {
    rawPath: `/api/oauth/${path}`,
    headers: { 'content-type': options.contentType ?? 'application/x-www-form-urlencoded' },
    body: base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: base64,
    requestContext: { routeKey: `POST /api/oauth/${path}`, http: { method: options.method ?? 'POST', sourceIp: options.ip ?? '192.0.2.1' } },
  } as unknown as APIGatewayProxyEventV2;
}

async function token(fields: Record<string, string>, ip?: string) {
  const res = await handleOauthPublic(call('token', form(fields)), deps);
  return { res, body: JSON.parse(res?.body ?? '{}') };
}

async function codeFor(scope: 'read' | 'write' = 'write', overrides: Partial<{ redirectUri: string; clientId: string }> = {}): Promise<string> {
  return issueCode(store, {
    clientId: overrides.clientId ?? clientId, userId: 'u1', scope, redirectUri: overrides.redirectUri ?? REDIRECT, codeChallenge: CHALLENGE,
  }, NOW);
}

function exchange(code: string, extra: Record<string, string> = {}): Record<string, string> {
  return { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER, ...extra };
}

beforeEach(async () => {
  store = new MemoryStore();
  deps = {
    getStore: async () => store,
    discoveryLimiter: createFailureLimiter({ maxFailures: 60, windowSeconds: 60, blockSeconds: 60 }),
    origin: 'https://hoard.example',
    limiter: createFailureLimiter({ maxFailures: 10, windowSeconds: 3600, blockSeconds: 3600 }),
    tokenLimiter: createFailureLimiter({ maxFailures: 30, windowSeconds: 600, blockSeconds: 600 }),
    revokeLimiter: createFailureLimiter({ maxFailures: 30, windowSeconds: 600, blockSeconds: 600 }),
    nowSeconds: NOW + 5,
  };
  clientId = (await registerClient(store, { name: 'Claude', redirectUris: [REDIRECT] }, NOW)).clientId;
});

describe('POST /api/oauth/token, authorization_code', () => {
  it('exchanges a code with a real S256 verifier for tokens that authenticate, at the consented scope', async () => {
    const { res, body } = await token(exchange(await codeFor('read')));
    expect(res?.statusCode).toBe(200);
    expect(res?.headers).toMatchObject({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read' });
    expect(body.access_token).toMatch(/^hwr_/);
    expect(body.refresh_token).toEqual(expect.any(String));

    const auth = await authenticateToken(
      { headers: { authorization: `Bearer ${body.access_token}` } } as unknown as APIGatewayProxyEventV2, store, NOW + 10,
    );
    expect(auth).toMatchObject({ userId: 'u1', scope: 'read' });
    expect((await listTokens(store, 'u1'))[0]).toMatchObject({ name: 'Claude', kind: 'oauth' });
  });

  it('gives a write consent an hww_ token', async () => {
    const { body } = await token(exchange(await codeFor('write')));
    expect(body.access_token).toMatch(/^hww_/);
    expect(body.scope).toBe('write');
  });

  it('accepts a base64 encoded body', async () => {
    const res = await handleOauthPublic(call('token', form(exchange(await codeFor())), { base64: true }), deps);
    expect(res?.statusCode).toBe(200);
  });

  it('ignores client_secret and client_assertion and never echoes them', async () => {
    const { res } = await token(exchange(await codeFor(), { client_secret: 'topsecret-value', client_assertion: 'assertion-value' }));
    expect(res?.statusCode).toBe(200);
    expect(res?.body).not.toContain('topsecret-value');
    expect(res?.body).not.toContain('assertion-value');
  });

  it('answers every grant failure with the same invalid_grant body', async () => {
    const wrongVerifier = 'A'.repeat(43);
    const other = (await registerClient(store, { name: 'Other', redirectUris: [REDIRECT] }, NOW)).clientId;
    const attempts: Array<Record<string, string>> = [
      exchange(await codeFor(), { code_verifier: wrongVerifier }),
      exchange(await codeFor(), { redirect_uri: 'https://claude.ai/other' }),
      exchange(await codeFor(), { client_id: other }),
      exchange('never-issued-code'),
      exchange(await codeFor(), { code_verifier: 'short' }),
    ];
    const reused = await codeFor();
    await token(exchange(reused));
    attempts.push(exchange(reused));

    const bodies = new Set<string>();
    for (const attempt of attempts) {
      const { res } = await token(attempt);
      expect(res?.statusCode).toBe(400);
      bodies.add(res?.body ?? '');
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0])).toMatchObject({ error: 'invalid_grant' });
  });

  it('answers an expired code with invalid_grant', async () => {
    const code = await codeFor();
    const res = await handleOauthPublic(call('token', form(exchange(code))), { ...deps, nowSeconds: NOW + 61 });
    expect(JSON.parse(res?.body ?? '{}').error).toBe('invalid_grant');
  });

  it('burns the code on a wrong verifier, so the right one then fails', async () => {
    const code = await codeFor();
    await token(exchange(code, { code_verifier: 'B'.repeat(43) }));
    const { res, body } = await token(exchange(code));
    expect(res?.statusCode).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  it('has no field that accepts the plain method', async () => {
    const plainCode = await issueCode(store, { clientId, userId: 'u1', scope: 'read', redirectUri: REDIRECT, codeChallenge: VERIFIER }, NOW);
    const { res, body } = await token(exchange(plainCode));
    expect(res?.statusCode).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  it('answers an unknown client_id with 401 invalid_client', async () => {
    const { res, body } = await token(exchange(await codeFor(), { client_id: 'nope' }));
    expect(res?.statusCode).toBe(401);
    expect(body.error).toBe('invalid_client');
  });

  it('burns the code even when the client is unknown', async () => {
    const code = await codeFor();
    const unknown = await token(exchange(code, { client_id: 'nope' }));
    expect(unknown.res?.statusCode).toBe(401);
    expect(unknown.body.error).toBe('invalid_client');
    const retry = await token(exchange(code));
    expect(retry.res?.statusCode).toBe(400);
    expect(retry.body.error).toBe('invalid_grant');
  });

  it('answers 400 invalid_grant when the user is at the token limit, without a secret', async () => {
    for (let i = 0; i < MAX_TOKENS_PER_USER; i++) {
      await createToken(store, { userId: 'u1', name: `t${i}`, scope: 'read', expiryDays: 90 }, NOW);
    }
    const { res, body } = await token(exchange(await codeFor()));
    expect(res?.statusCode).toBe(400);
    expect(body).toEqual({
      error: 'invalid_grant',
      error_description: 'Too many connections or tokens. Remove one in Settings and connect again.',
    });
  });

  it.each(['code', 'redirect_uri', 'client_id', 'code_verifier'])('answers a missing %s with 400 invalid_request', async (field) => {
    const fields = exchange(await codeFor());
    delete fields[field];
    const { res, body } = await token(fields);
    expect(res?.statusCode).toBe(400);
    expect(body.error).toBe('invalid_request');
  });
});

describe('POST /api/oauth/token, refresh_token', () => {
  async function connect(): Promise<{ access: string; refresh: string }> {
    const { body } = await token(exchange(await codeFor()));
    return { access: body.access_token, refresh: body.refresh_token };
  }

  it('rotates to new tokens in the same shape', async () => {
    const first = await connect();
    const { res, body } = await token({ grant_type: 'refresh_token', refresh_token: first.refresh, client_id: clientId });
    expect(res?.statusCode).toBe(200);
    expect(res?.headers).toMatchObject({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'write' });
    expect(body.access_token).not.toBe(first.access);
    expect(body.refresh_token).not.toBe(first.refresh);
    expect(await findToken(store, body.access_token, NOW + 10)).toBeDefined();
  });

  it('treats the old refresh token as reused and revokes the connection', async () => {
    const first = await connect();
    const second = (await token({ grant_type: 'refresh_token', refresh_token: first.refresh, client_id: clientId })).body;
    const replay = await token({ grant_type: 'refresh_token', refresh_token: first.refresh, client_id: clientId });
    expect(replay.res?.statusCode).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(await findToken(store, second.access_token, NOW + 10)).toBeUndefined();
    const next = await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: clientId });
    expect(next.body.error).toBe('invalid_grant');
  });

  it('answers an unknown refresh token with invalid_grant', async () => {
    const { res, body } = await token({ grant_type: 'refresh_token', refresh_token: 'nothing', client_id: clientId });
    expect(res?.statusCode).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  it('answers an unknown client_id with 401 invalid_client', async () => {
    const first = await connect();
    const { res, body } = await token({ grant_type: 'refresh_token', refresh_token: first.refresh, client_id: 'nope' });
    expect(res?.statusCode).toBe(401);
    expect(body.error).toBe('invalid_client');
  });

  it('answers another client_id with invalid_grant and leaves the token usable', async () => {
    const first = await connect();
    const other = (await registerClient(store, { name: 'Other', redirectUris: [REDIRECT] }, NOW)).clientId;
    const wrong = await token({ grant_type: 'refresh_token', refresh_token: first.refresh, client_id: other });
    expect(wrong.body.error).toBe('invalid_grant');
    const right = await token({ grant_type: 'refresh_token', refresh_token: first.refresh, client_id: clientId });
    expect(right.res?.statusCode).toBe(200);
  });

  it.each(['refresh_token', 'client_id'])('answers a missing %s with 400 invalid_request', async (field) => {
    const fields: Record<string, string> = { grant_type: 'refresh_token', refresh_token: 'x', client_id: clientId };
    delete fields[field];
    const { res, body } = await token(fields);
    expect(res?.statusCode).toBe(400);
    expect(body.error).toBe('invalid_request');
  });
});

describe('client expiry', () => {
  const DAY = 86400;
  async function at(seconds: number, fields: Record<string, string>) {
    const res = await handleOauthPublic(call('token', form(fields)), { ...deps, nowSeconds: seconds });
    return { res, body: JSON.parse(res?.body ?? '{}') };
  }

  it('keeps a client alive while its connection is refreshed', async () => {
    const exchanged = await at(NOW, exchange(await codeFor()));
    expect(exchanged.res?.statusCode).toBe(200);
    const second = await at(NOW + 89 * DAY, { grant_type: 'refresh_token', refresh_token: exchanged.body.refresh_token, client_id: clientId });
    expect(second.res?.statusCode).toBe(200);
    const third = await at(NOW + 100 * DAY, { grant_type: 'refresh_token', refresh_token: second.body.refresh_token, client_id: clientId });
    expect(third.res?.statusCode).toBe(200);
  });
});

describe('POST /api/oauth/token, request shape', () => {
  it('answers another grant_type with 400 unsupported_grant_type', async () => {
    const { res, body } = await token({ grant_type: 'password', client_id: clientId });
    expect(res?.statusCode).toBe(400);
    expect(body.error).toBe('unsupported_grant_type');
  });

  it('answers a missing grant_type with invalid_request', async () => {
    const { body } = await token({ client_id: clientId });
    expect(body.error).toBe('invalid_request');
  });

  it('answers a duplicated parameter with invalid_request', async () => {
    const res = await handleOauthPublic(call('token', `${form(exchange('c'))}&code=second`), deps);
    expect(res?.statusCode).toBe(400);
    expect(JSON.parse(res?.body ?? '{}').error).toBe('invalid_request');
  });

  it('answers a JSON body with 415', async () => {
    const res = await handleOauthPublic(call('token', JSON.stringify(exchange('c')), { contentType: 'application/json' }), deps);
    expect(res?.statusCode).toBe(415);
  });

  it('accepts a content type with a charset parameter', async () => {
    const res = await handleOauthPublic(call('token', form(exchange(await codeFor())), { contentType: 'application/x-www-form-urlencoded; charset=UTF-8' }), deps);
    expect(res?.statusCode).toBe(200);
  });

  it('answers a body over 8 KiB with 413 before parsing it', async () => {
    const res = await handleOauthPublic(call('token', `grant_type=authorization_code&code=${'a'.repeat(8 * 1024)}`), deps);
    expect(res?.statusCode).toBe(413);
    expect(JSON.parse(res?.body ?? '{}').error).toBe('invalid_request');
  });

  it.each(['token', 'revoke'] as const)('answers GET %s with 405 and Allow: POST', async (path) => {
    const res = await handleOauthPublic(call(path, '', { method: 'GET' }), deps);
    expect(res?.statusCode).toBe(405);
    expect(res?.headers?.Allow).toBe('POST');
  });

  it.each(['token', 'revoke'] as const)('answers %s with 404 when no origin is configured', async (path) => {
    const res = await handleOauthPublic(call(path, form({ token: 'x' })), { ...deps, origin: undefined });
    expect(res?.statusCode).toBe(404);
  });

  it('counts failures per address, then answers 429 with Retry-After', async () => {
    const attempt = () => handleOauthPublic(call('token', form(exchange('bad')), { ip: '198.51.100.7' }), deps);
    for (let i = 0; i < 30; i++) expect((await attempt())?.statusCode).toBe(400);
    const blocked = await attempt();
    expect(blocked?.statusCode).toBe(429);
    expect(blocked?.headers?.['Retry-After']).toBe('600');
    const elsewhere = await handleOauthPublic(call('token', form(exchange('bad')), { ip: '198.51.100.8' }), deps);
    expect(elsewhere?.statusCode).toBe(400);
  });

  it('does not count successes', async () => {
    for (let i = 0; i < 40; i++) {
      const res = await handleOauthPublic(call('token', form(exchange(await codeFor())), { ip: '198.51.100.9' }), deps);
      expect(res?.statusCode).toBe(200);
    }
  });
});

describe('POST /api/oauth/revoke', () => {
  async function connect(): Promise<{ access: string; refresh: string }> {
    const { body } = await token(exchange(await codeFor()));
    return { access: body.access_token, refresh: body.refresh_token };
  }

  async function revoke(fields: Record<string, string>) {
    const res = await handleOauthPublic(call('revoke', form(fields)), deps);
    return res;
  }

  it('removes the connection when given the access token', async () => {
    const conn = await connect();
    const res = await revoke({ token: conn.access, token_type_hint: 'access_token' });
    expect(res?.statusCode).toBe(200);
    expect(JSON.parse(res?.body ?? '')).toEqual({});
    expect(await findToken(store, conn.access, NOW + 10)).toBeUndefined();
    expect(await listTokens(store, 'u1')).toHaveLength(0);
    expect(await rotateConnection(store, conn.refresh, clientId, NOW + 10)).toBe('invalid');
  });

  it('removes the connection when given the refresh token', async () => {
    const conn = await connect();
    const res = await revoke({ token: conn.refresh, token_type_hint: 'refresh_token' });
    expect(res?.statusCode).toBe(200);
    expect(await findToken(store, conn.access, NOW + 10)).toBeUndefined();
    expect(await listTokens(store, 'u1')).toHaveLength(0);
  });

  it('removes the connection when given a rotated-out refresh token', async () => {
    const conn = await connect();
    const next = (await token({ grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: clientId })).body;
    await revoke({ token: conn.refresh });
    expect(await findToken(store, next.access_token, NOW + 10)).toBeUndefined();
  });

  it('ignores the hint when it is wrong', async () => {
    const conn = await connect();
    await revoke({ token: conn.refresh, token_type_hint: 'access_token' });
    expect(await listTokens(store, 'u1')).toHaveLength(0);
  });

  it('answers 200 with an empty object for an unknown token', async () => {
    const res = await revoke({ token: 'whatever' });
    expect(res?.statusCode).toBe(200);
    expect(JSON.parse(res?.body ?? '')).toEqual({});
    expect(res?.headers?.['Cache-Control']).toBe('no-store');
  });

  it('does not revoke a personal token, which stays usable', async () => {
    const { token: personal } = await createToken(store, { userId: 'u1', name: 'Mine', scope: 'read', expiryDays: 90 }, NOW);
    const res = await revoke({ token: personal });
    expect(res?.statusCode).toBe(200);
    expect(await findToken(store, personal, NOW + 10)).toBeDefined();
    expect(await listTokens(store, 'u1')).toHaveLength(1);
  });

  it('leaves another user connection alone when the token is unknown', async () => {
    const conn = await connect();
    await revoke({ token: 'hwr_' + 'a'.repeat(43) });
    expect(await findToken(store, conn.access, NOW + 10)).toBeDefined();
  });

  it('ignores a token that belongs to another client when client_id is given', async () => {
    const conn = await connect();
    const other = (await registerClient(store, { name: 'Other', redirectUris: [REDIRECT] }, NOW)).clientId;
    await revoke({ token: conn.access, client_id: other });
    expect(await findToken(store, conn.access, NOW + 10)).toBeDefined();
    await revoke({ token: conn.access, client_id: clientId });
    expect(await findToken(store, conn.access, NOW + 10)).toBeUndefined();
  });

  it('answers a missing token with 400 invalid_request, a JSON body with 415 and a large one with 413', async () => {
    expect((await revoke({}))?.statusCode).toBe(400);
    expect((await handleOauthPublic(call('revoke', '{}', { contentType: 'application/json' }), deps))?.statusCode).toBe(415);
    expect((await handleOauthPublic(call('revoke', `token=${'a'.repeat(9000)}`), deps))?.statusCode).toBe(413);
  });

  it('does not extend a block while the address keeps calling', async () => {
    let clock = 1000;
    const revokeLimiter = createFailureLimiter({ maxFailures: 3, windowSeconds: 600, blockSeconds: 600 }, () => clock);
    const d = { ...deps, revokeLimiter };
    const send = () => handleOauthPublic(call('revoke', form({ token: 'x' })), d);
    for (let i = 0; i < 4; i++) await send();
    expect((await send())?.statusCode).toBe(429);
    clock = 1500;
    expect((await send())?.statusCode).toBe(429);
    clock = 1000 + 600;
    expect((await send())?.statusCode).toBe(200);
  });

  it('answers 429 after too many requests from one address', async () => {
    let last;
    for (let i = 0; i < 32; i++) last = await revoke({ token: 'x' });
    expect(last?.statusCode).toBe(429);
  });
});

describe('logging', () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  afterEach(() => vi.restoreAllMocks());

  it('never logs a token, refresh token, code or verifier on any path', async () => {
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const secrets: string[] = [VERIFIER];

    const code = await codeFor();
    secrets.push(code);
    const { body } = await token(exchange(code));
    secrets.push(body.access_token, body.refresh_token);
    await token(exchange(code));
    await token(exchange(await codeFor(), { code_verifier: 'C'.repeat(43) }));
    await token(exchange(await codeFor(), { client_id: 'nope' }));
    await token({ grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: clientId });
    await token({ grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: clientId });
    await handleOauthPublic(call('token', 'not-a-form&&'), deps);
    await handleOauthPublic(call('revoke', form({ token: body.access_token })), deps);
    await handleOauthPublic(call('revoke', form({ token: body.refresh_token })), deps);

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    for (const secret of secrets) expect(logged).not.toContain(secret);
  });
});
