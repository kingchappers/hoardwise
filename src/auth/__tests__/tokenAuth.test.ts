import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory';
import { authenticateToken, presentsAccessToken, tokenAccessRejection } from '../tokenAuth';
import { createToken, revokeToken } from '../tokens';

const NOW = 1_800_000_000;
const UNAUTHORIZED = '{"error":"Unauthorized"}';
let store: MemoryStore;

function eventWith(authorization?: string): APIGatewayProxyEventV2 {
  return { headers: authorization === undefined ? {} : { authorization } } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => { store = new MemoryStore(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('presentsAccessToken', () => {
  it('is true for hwr_ and hww_ bearer tokens', () => {
    expect(presentsAccessToken(eventWith('Bearer hwr_x'))).toBe(true);
    expect(presentsAccessToken(eventWith('Bearer hww_x'))).toBe(true);
  });

  it('matches the Bearer scheme in any case, followed by one or more spaces', () => {
    expect(presentsAccessToken(eventWith('bearer hwr_x'))).toBe(true);
    expect(presentsAccessToken(eventWith('BEARER   hww_x'))).toBe(true);
  });

  it('is false for a JWT, a missing header, an upper-case token prefix and a missing Bearer', () => {
    expect(presentsAccessToken(eventWith('Bearer eyJhbGciOi.eyJzdWIi.sig'))).toBe(false);
    expect(presentsAccessToken(eventWith())).toBe(false);
    expect(presentsAccessToken(eventWith('Bearer HWR_x'))).toBe(false);
    expect(presentsAccessToken(eventWith('Bearerhwr_x'))).toBe(false);
    expect(presentsAccessToken(eventWith('hwr_x'))).toBe(false);
  });
});

describe('authenticateToken', () => {
  it('returns the user and scope for a valid token', async () => {
    const { token } = await createToken(store, { userId: 'u1', name: 't', scope: 'write', expiryDays: 90 }, NOW);
    const result = await authenticateToken(eventWith(`Bearer ${token}`), store, NOW);
    expect(result).toMatchObject({ userId: 'u1', scope: 'write' });
  });

  it.each(['bearer ', 'BEARER   '])('accepts the scheme written as %j', async (scheme) => {
    const { token } = await createToken(store, { userId: 'u1', name: 't', scope: 'read', expiryDays: 90 }, NOW);
    const result = await authenticateToken(eventWith(`${scheme}${token}`), store, NOW);
    expect(result).toMatchObject({ userId: 'u1', scope: 'read' });
  });

  it('gives identical 401s for unknown, expired and revoked tokens', async () => {
    const unknown = `hwr_${'A'.repeat(43)}`;
    const expired = await createToken(store, { userId: 'u1', name: 'e', scope: 'read', expiryDays: 90 }, NOW);
    const revoked = await createToken(store, { userId: 'u1', name: 'r', scope: 'read', expiryDays: null }, NOW);
    await revokeToken(store, 'u1', revoked.record.tokenId);
    const later = NOW + 91 * 24 * 60 * 60;

    const results = await Promise.all([
      authenticateToken(eventWith(`Bearer ${unknown}`), store, NOW),
      authenticateToken(eventWith(`Bearer ${expired.token}`), store, later),
      authenticateToken(eventWith(`Bearer ${revoked.token}`), store, NOW),
    ]);
    for (const result of results) {
      expect(result).toHaveProperty('rejection');
      if (!('rejection' in result)) return;
      expect(result.rejection.statusCode).toBe(401);
      expect(result.rejection.body).toBe(UNAUTHORIZED);
    }
    const [a, b, c] = results.map((r) => ('rejection' in r ? r.rejection : undefined));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('rejects a malformed token without touching the store', async () => {
    const get = vi.spyOn(store, 'get');
    const bodies = [
      `hwr_${'A'.repeat(42)}`,
      `hwr_${'A'.repeat(44)}`,
      `hwr_${'A'.repeat(42)}!`,
      `hww_${'A'.repeat(43)} `,
    ];
    for (const body of bodies) {
      const result = await authenticateToken(eventWith(`Bearer ${body}`), store, NOW);
      expect(result).toHaveProperty('rejection.statusCode', 401);
    }
    const lowerCase = await authenticateToken(eventWith(`bearer  hwr_${'A'.repeat(42)}`), store, NOW);
    expect(lowerCase).toHaveProperty('rejection.statusCode', 401);
    expect(get).not.toHaveBeenCalled();
  });

  it('logs a failure without the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const token = `hwr_${'Q'.repeat(43)}`;
    await authenticateToken(eventWith(`Bearer ${token}`), store, NOW);
    await authenticateToken(eventWith(`Bearer ${token}x`), store, NOW);
    expect(warn).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('QQQQ');
    expect(logged).not.toContain('hwr_');
    expect(logged).toContain('unknown-or-expired');
    expect(logged).toContain('malformed');
  });
});

describe('tokenAccessRejection', () => {
  it('lets a read token make GET and HEAD', () => {
    expect(tokenAccessRejection('read', 'GET', '/api/transactions')).toBeUndefined();
    expect(tokenAccessRejection('read', 'HEAD', '/api/transactions')).toBeUndefined();
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'get', 'PROPFIND'])('refuses %s on a read token', (method) => {
    const refusal = tokenAccessRejection('read', method, '/api/transactions');
    expect(refusal?.reason).toBe('read-only');
    expect(refusal?.rejection.statusCode).toBe(403);
    expect(refusal?.rejection.body).toBe('{"error":"This token is read-only"}');
  });

  it.each(['read', 'write'] as const)('refuses the account paths for a %s token', (scope) => {
    for (const path of ['/api/auth/me', '/api/tokens', '/api/tokens/abc', '/api/push/subscriptions', '/api/oauth/authorize', '/api/oauth/client']) {
      const refusal = tokenAccessRejection(scope, 'GET', path);
      expect(refusal?.reason).toBe('account-route');
      expect(refusal?.rejection.statusCode).toBe(403);
      expect(refusal?.rejection.body).toBe('{"error":"Not available to access tokens"}');
    }
  });

  it.each(['read', 'write'] as const)('refuses bare /api/auth and /api/push for a %s token', (scope) => {
    for (const path of ['/api/auth', '/api/push', '/api/oauth']) {
      const refusal = tokenAccessRejection(scope, 'GET', path);
      expect(refusal?.reason).toBe('account-route');
      expect(refusal?.rejection.statusCode).toBe(403);
      expect(refusal?.rejection.body).toBe('{"error":"Not available to access tokens"}');
    }
  });

  it('checks the path rule before the read-only rule', () => {
    expect(tokenAccessRejection('read', 'POST', '/api/tokens')?.reason).toBe('account-route');
  });

  it('lets a write token write', () => {
    expect(tokenAccessRejection('write', 'POST', '/api/transactions')).toBeUndefined();
  });
});
