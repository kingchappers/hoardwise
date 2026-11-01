import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory';
import { createFailureLimiter } from '../../auth/failureLimiter';
import { oauthOrigin } from '../config';
import { authorizationServerMetadata, protectedResourceMetadata } from '../metadata';
import { handleOauthPublic } from '../routes';

const ORIGIN = 'https://hoard.example';

function event(method: string, rawPath: string, headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    rawPath,
    headers,
    isBase64Encoded: false,
    requestContext: { routeKey: `${method} ${rawPath}`, http: { method, sourceIp: '192.0.2.1' } },
  } as unknown as APIGatewayProxyEventV2;
}

function deps(origin: string | undefined) {
  return { getStore: async () => new MemoryStore(), discoveryLimiter: createFailureLimiter({ maxFailures: 60, windowSeconds: 60, blockSeconds: 60 }), origin, limiter: createFailureLimiter(), nowSeconds: 1_800_000_000 };
}

afterEach(() => vi.restoreAllMocks());

describe('oauthOrigin', () => {
  it.each([
    ['https://hoard.example', 'https://hoard.example'],
    ['https://hoard.example:8443', 'https://hoard.example:8443'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    [' https://hoard.example ', 'https://hoard.example'],
  ])('accepts %s', (value, expected) => {
    expect(oauthOrigin({ APP_ORIGIN: value })).toBe(expected);
  });

  it.each([
    'http://hoard.example',
    'https://hoard.example/path',
    'https://hoard.example/?q=1',
    'https://hoard.example/#f',
    'https://user:pw@hoard.example',
    'ftp://hoard.example',
    'hoard.example',
    '',
  ])('treats %j as disabled', (value) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(oauthOrigin({ APP_ORIGIN: value })).toBeUndefined();
  });

  it('is disabled when unset', () => {
    expect(oauthOrigin({})).toBeUndefined();
  });

  it('warns without echoing the value when set but invalid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    oauthOrigin({ APP_ORIGIN: 'https://user:secret@hoard.example' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
});

describe('metadata documents', () => {
  it('describes the protected resource', () => {
    expect(protectedResourceMetadata(ORIGIN)).toEqual({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: ['read', 'write'],
      bearer_methods_supported: ['header'],
    });
  });

  it('describes the authorization server', () => {
    expect(authorizationServerMetadata(ORIGIN)).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/connect`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'write'],
    });
  });
});

describe('discovery routes', () => {
  it.each([
    ['/.well-known/oauth-protected-resource', protectedResourceMetadata(ORIGIN)],
    ['/.well-known/oauth-authorization-server', authorizationServerMetadata(ORIGIN)],
  ])('serves %s, cacheable for an hour', async (path, document) => {
    const res = await handleOauthPublic(event('GET', path), deps(ORIGIN));
    expect(res?.statusCode).toBe(200);
    expect(JSON.parse(res?.body ?? '')).toEqual(document);
    expect(res?.headers?.['Cache-Control']).toBe('public, max-age=3600');
    expect(res?.headers?.['X-Content-Type-Options']).toBe('nosniff');
  });

  it('ignores Host and X-Forwarded-* headers', async () => {
    const res = await handleOauthPublic(
      event('GET', '/.well-known/oauth-authorization-server', { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' }),
      deps(ORIGIN),
    );
    expect(res?.body).not.toContain('evil.example');
    expect(JSON.parse(res?.body ?? '').issuer).toBe(ORIGIN);
  });

  it.each(['POST', 'HEAD', 'DELETE'])('answers %s with 405 and Allow: GET', async (method) => {
    const res = await handleOauthPublic(event(method, '/.well-known/oauth-protected-resource'), deps(ORIGIN));
    expect(res?.statusCode).toBe(405);
    expect(res?.headers?.Allow).toBe('GET');
  });

  it('returns undefined for any other path', async () => {
    expect(await handleOauthPublic(event('GET', '/.well-known/other'), deps(ORIGIN))).toBeUndefined();
    expect(await handleOauthPublic(event('GET', '/api/categories'), deps(ORIGIN))).toBeUndefined();
  });

  it.each([
    ['GET', '/.well-known/oauth-protected-resource'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['POST', '/api/oauth/register'],
  ])('answers %s %s with 404 when no origin is configured', async (method, path) => {
    const res = await handleOauthPublic(event(method, path), deps(undefined));
    expect(res?.statusCode).toBe(404);
  });
});

describe('discovery rate limit', () => {
  const PATH = '/.well-known/oauth-protected-resource';

  it('answers 429 with Retry-After on the 61st request in a minute from one address', async () => {
    const d = deps(ORIGIN);
    for (let i = 0; i < 60; i++) expect((await handleOauthPublic(event('GET', PATH), d))?.statusCode).toBe(200);
    const res = await handleOauthPublic(event('GET', PATH), d);
    expect(res?.statusCode).toBe(429);
    expect(res?.headers?.['Retry-After']).toBe('60');
  });

  it('leaves a normal caller, and other addresses, unaffected', async () => {
    const d = deps(ORIGIN);
    for (let i = 0; i < 61; i++) await handleOauthPublic(event('GET', PATH), d);
    const other = event('GET', PATH);
    (other.requestContext.http as { sourceIp: string }).sourceIp = '192.0.2.99';
    expect((await handleOauthPublic(other, d))?.statusCode).toBe(200);
  });

  it('does not need the store', async () => {
    const getStore = vi.fn().mockRejectedValue(new Error('down'));
    const res = await handleOauthPublic(event('GET', PATH), { ...deps(ORIGIN), getStore });
    expect(res?.statusCode).toBe(200);
    expect(getStore).not.toHaveBeenCalled();
  });
});
