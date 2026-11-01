import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { err } from '../api/http';
import type { ApiResponse } from '../api/types';
import type { Store } from '../store';
import { TOKEN_PATTERN, findToken } from './tokens';
import type { StoredToken, TokenScope } from './tokens';

export type TokenAuthResult =
  | { userId: string; scope: TokenScope; stored: StoredToken }
  | { rejection: ApiResponse };

export type TokenRefusal = { rejection: ApiResponse; reason: 'account-route' | 'read-only' };

// The scheme is case-insensitive (RFC 7235); the token prefix after it is not.
const BEARER_SCHEME = /^bearer +/i;
const TOKEN_PREFIXES = ['hwr_', 'hww_'];
const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);
const NON_TOKEN_PATHS = ['/api/auth', '/api/tokens', '/api/push', '/api/oauth'];

function authorizationHeader(event: APIGatewayProxyEventV2): string {
  return event.headers?.authorization ?? '';
}

function bearerCredential(event: APIGatewayProxyEventV2): string {
  const header = authorizationHeader(event);
  const scheme = BEARER_SCHEME.exec(header);
  if (!scheme) return '';
  return header.slice(scheme[0].length);
}

export function presentsAccessToken(event: APIGatewayProxyEventV2): boolean {
  const credential = bearerCredential(event);
  return TOKEN_PREFIXES.some((prefix) => credential.startsWith(prefix));
}

function reject(reason: 'malformed' | 'unknown-or-expired'): { rejection: ApiResponse } {
  console.warn('Token auth rejected:', reason);
  return { rejection: err(401, 'Unauthorized') };
}

export async function authenticateToken(
  event: APIGatewayProxyEventV2,
  store: Store,
  nowSeconds: number,
): Promise<TokenAuthResult> {
  const token = bearerCredential(event);
  if (!TOKEN_PATTERN.test(token)) return reject('malformed');

  const stored = await findToken(store, token, nowSeconds);
  if (!stored) return reject('unknown-or-expired');
  return { userId: stored.userId, scope: stored.scope, stored };
}

export function tokenAccessRejection(scope: TokenScope, method: string, path: string): TokenRefusal | undefined {
  if (NON_TOKEN_PATHS.some((prefix) => path.startsWith(prefix))) {
    return { rejection: err(403, 'Not available to access tokens'), reason: 'account-route' };
  }
  if (scope === 'read' && !READ_ONLY_METHODS.has(method)) {
    return { rejection: err(403, 'This token is read-only'), reason: 'read-only' };
  }
  return undefined;
}
