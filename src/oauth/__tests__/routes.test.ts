import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory';
import { createFailureLimiter } from '../../auth/failureLimiter';
import { getClient } from '../clients';
import { MAX_CLIENTS } from '../types';
import { handleOauthPublic } from '../routes';
import type { OauthPublicDeps } from '../routes';

const NOW = 1_800_000_000;
let store: MemoryStore;
let deps: OauthPublicDeps;

function post(body: unknown, options: { ip?: string; method?: string; raw?: string } = {}): APIGatewayProxyEventV2 {
  return {
    rawPath: '/api/oauth/register',
    headers: { 'content-type': 'application/json' },
    body: options.raw ?? JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { routeKey: 'POST /api/oauth/register', http: { method: options.method ?? 'POST', sourceIp: options.ip ?? '192.0.2.1' } },
  } as unknown as APIGatewayProxyEventV2;
}

const valid = {
  client_name: 'Claude',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
};

beforeEach(() => {
  store = new MemoryStore();
  deps = { getStore: async () => store, discoveryLimiter: createFailureLimiter({ maxFailures: 60, windowSeconds: 60, blockSeconds: 60 }), origin: 'https://hoard.example', limiter: createFailureLimiter({ maxFailures: 60, windowSeconds: 3600, blockSeconds: 3600 }), tokenLimiter: createFailureLimiter(), revokeLimiter: createFailureLimiter(), nowSeconds: NOW };
});

describe('POST /api/oauth/register', () => {
  it('registers a client and returns it without a secret', async () => {
    const res = await handleOauthPublic(post(valid), deps);
    expect(res?.statusCode).toBe(201);
    const body = JSON.parse(res?.body ?? '');
    expect(body).toMatchObject({
      client_name: 'Claude',
      redirect_uris: valid.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(body.client_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body).not.toHaveProperty('client_secret');
    expect(res?.headers?.['Cache-Control']).toBe('no-store');
    expect(await getClient(store, body.client_id, NOW)).toBeDefined();
  });

  it.each(['none', 'client_secret_post', 'client_secret_basic'])(
    'registers a %s request as a public client, with no secret in the response',
    async (method) => {
      const res = await handleOauthPublic(post({ ...valid, token_endpoint_auth_method: method }), deps);
      expect(res?.statusCode).toBe(201);
      const body = JSON.parse(res?.body ?? '');
      expect(body).toMatchObject({ token_endpoint_auth_method: 'none' });
      expect(body).not.toHaveProperty('client_secret');
      expect(body).not.toHaveProperty('client_secret_expires_at');
      expect(Object.keys(body).sort()).toEqual([
        'client_id', 'client_id_issued_at', 'client_name', 'grant_types', 'redirect_uris', 'response_types', 'token_endpoint_auth_method',
      ]);
    },
  );

  it('ignores and does not store extra RFC 7591 fields, including an unknown scope', async () => {
    const extras = {
      scope: 'bogus:scope', contacts: ['a@example.com'], client_uri: 'https://claude.ai', logo_uri: 'https://claude.ai/l.png',
      tos_uri: 'https://claude.ai/tos', policy_uri: 'https://claude.ai/p', software_id: 'sw', software_version: '1',
      jwks: { keys: [] }, jwks_uri: 'https://claude.ai/jwks', something_new: { nested: true },
    };
    const res = await handleOauthPublic(post({ ...valid, ...extras }), deps);
    expect(res?.statusCode).toBe(201);
    const body = JSON.parse(res?.body ?? '');
    for (const name of Object.keys(extras)) expect(body).not.toHaveProperty(name);
    const stored = await store.query('OAUTH#CLIENTS');
    expect(JSON.stringify(stored)).not.toMatch(/bogus:scope|a@example.com|jwks|sw"/);
  });

  it('accepts a body with only the required fields', async () => {
    const res = await handleOauthPublic(post({ redirect_uris: valid.redirect_uris }), deps);
    expect(res?.statusCode).toBe(201);
  });

  it.each([
    { token_endpoint_auth_method: 'private_key_jwt' },
    { token_endpoint_auth_method: 42 },
    { grant_types: ['implicit'] },
    { response_types: ['token'] },
    { client_name: 42 },
  ])('rejects %j as invalid_client_metadata', async (override) => {
    const res = await handleOauthPublic(post({ ...valid, ...override }), deps);
    expect(res?.statusCode).toBe(400);
    expect(JSON.parse(res?.body ?? '').error).toBe('invalid_client_metadata');
  });

  it.each(['not json', '[]', 'null'])('rejects the body %s', async (raw) => {
    const res = await handleOauthPublic(post(undefined, { raw }), deps);
    expect(res?.statusCode).toBe(400);
    expect(JSON.parse(res?.body ?? '').error).toBe('invalid_client_metadata');
  });

  it.each([
    { redirect_uris: ['http://example.com/cb'] },
    { redirect_uris: [] },
    { redirect_uris: 'https://claude.ai/cb' },
    { redirect_uris: undefined },
  ])('rejects %j as invalid_redirect_uri', async (override) => {
    const res = await handleOauthPublic(post({ ...valid, ...override }), deps);
    expect(res?.statusCode).toBe(400);
    expect(JSON.parse(res?.body ?? '').error).toBe('invalid_redirect_uri');
  });

  it('answers 413 for a body over 8 KiB', async () => {
    const res = await handleOauthPublic(post({ ...valid, client_name: 'a'.repeat(9000) }), deps);
    expect(res?.statusCode).toBe(413);
  });

  it('answers 429 with Retry-After on the 61st registration from one address in an hour', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await handleOauthPublic(post(valid), deps))?.statusCode).toBe(201);
    }
    const res = await handleOauthPublic(post(valid), deps);
    expect(res?.statusCode).toBe(429);
    expect(res?.headers?.['Retry-After']).toBe('3600');
  });

  it('counts invalid attempts too, and keeps addresses apart', async () => {
    for (let i = 0; i < 60; i++) await handleOauthPublic(post(undefined, { raw: 'nope' }), deps);
    expect((await handleOauthPublic(post(valid), deps))?.statusCode).toBe(429);
    expect((await handleOauthPublic(post(valid, { ip: '192.0.2.2' }), deps))?.statusCode).toBe(201);
  });

  it('answers 503 at the client cap without detail', async () => {
    for (let i = 0; i < MAX_CLIENTS; i++) {
      await store.put({ PK: 'OAUTH#CLIENTS', SK: `c${i}`, name: 'x', redirectUris: [], createdAt: NOW, usedAt: NOW, expiresAt: NOW + 1000 });
    }
    const res = await handleOauthPublic(post(valid), deps);
    expect(res?.statusCode).toBe(503);
    expect(res?.body).not.toMatch(/stack|OAUTH#|at /);
  });

  it('answers a GET with 405 and Allow: POST', async () => {
    const res = await handleOauthPublic(post(undefined, { method: 'GET' }), deps);
    expect(res?.statusCode).toBe(405);
    expect(res?.headers?.Allow).toBe('POST');
  });
});
