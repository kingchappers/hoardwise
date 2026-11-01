import { createHash, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { SECURITY_HEADERS } from '../api/constants';
import { err } from '../api/http';
import type { ApiResponse } from '../api/types';
import type { FailureLimiter } from '../auth/failureLimiter';
import { hashToken } from '../auth/localData';
import { LOOKUP_PK, TOKEN_PATTERN, TokenLimitError, listingPk, revokeToken } from '../auth/tokens';
import type { Store } from '../store';
import { ClientLimitError, InvalidRedirectError, getClient, registerClient, touchClient } from './clients';
import { consumeCode } from './codes';
import { createConnection, rotateConnection } from './connections';
import { REFRESH_PK, REFRESH_USED_PK } from './types';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';

export interface OauthPublicDeps {
  // Only registration needs the store, so it is opened lazily: discovery never depends on it.
  getStore: () => Promise<Store>;
  origin: string | undefined;
  limiter: FailureLimiter;
  // Counts every discovery request per address (60 a minute in the handler), apart from the registration limiter.
  discoveryLimiter: FailureLimiter;
  // Failed token requests per address (30 per 10 minutes in the handler; refresh grants are exempt), and every revoke request per address.
  tokenLimiter: FailureLimiter;
  revokeLimiter: FailureLimiter;
  nowSeconds: number;
}

const REGISTER_PATH = '/api/oauth/register';
const TOKEN_PATH = '/api/oauth/token';
const REVOKE_PATH = '/api/oauth/revoke';
const MAX_REGISTER_BODY_BYTES = 8 * 1024;
const MAX_FORM_BODY_BYTES = 8 * 1024;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const TOKEN_RETRY_AFTER_SECONDS = '600';
const RETRY_AFTER_SECONDS = '3600';
const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const RESPONSE_TYPES = ['code'];
// RFC 7591 lets the server replace a requested value. Every client is registered as a public client (PKCE, no secret), so a
// client asking for a secret method is told "none" and the token endpoint ignores any secret it then sends.
const REQUESTABLE_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];
const NO_STORE = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' };

const DISCOVERY: Record<string, (origin: string) => object> = {
  '/.well-known/oauth-protected-resource': protectedResourceMetadata,
  '/.well-known/oauth-authorization-server': authorizationServerMetadata,
};

function oauthError(status: number, error: string, description: string, extra: Record<string, string> = {}): ApiResponse {
  return { statusCode: status, headers: { ...NO_STORE, ...extra }, body: JSON.stringify({ error, error_description: description }) };
}

function methodNotAllowed(allow: string): ApiResponse {
  return { ...err(405, 'Method not allowed'), headers: { ...NO_STORE, Allow: allow } };
}

function isSubsetOf(value: unknown, allowed: string[]): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && allowed.includes(item));
}

function requestBody(event: APIGatewayProxyEventV2): string {
  if (event.body === undefined) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

function metadataProblem(input: Record<string, unknown>): string | undefined {
  if (input.client_name !== undefined && typeof input.client_name !== 'string') return 'client_name must be a string';
  const method = input.token_endpoint_auth_method;
  if (method !== undefined && (typeof method !== 'string' || !REQUESTABLE_AUTH_METHODS.includes(method))) {
    return 'Unsupported token_endpoint_auth_method';
  }
  if (input.grant_types !== undefined && !isSubsetOf(input.grant_types, GRANT_TYPES)) return 'Unsupported grant_types';
  if (input.response_types !== undefined && !isSubsetOf(input.response_types, RESPONSE_TYPES)) return 'Unsupported response_types';
  return undefined;
}

async function register(event: APIGatewayProxyEventV2, deps: OauthPublicDeps): Promise<ApiResponse> {
  // Every attempt counts, valid or not, so the limit bounds how fast one address can fill the client table.
  const sourceIp = event.requestContext.http.sourceIp;
  deps.limiter.recordFailure(sourceIp);
  if (deps.limiter.isBlocked(sourceIp)) {
    return oauthError(429, 'too_many_requests', 'Too many registrations. Try again later.', { 'Retry-After': RETRY_AFTER_SECONDS });
  }

  const body = requestBody(event);
  if (Buffer.byteLength(body, 'utf8') > MAX_REGISTER_BODY_BYTES) {
    return oauthError(413, 'invalid_client_metadata', 'Request body is too large.');
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return oauthError(400, 'invalid_client_metadata', 'The body must be a JSON object.');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return oauthError(400, 'invalid_client_metadata', 'The body must be a JSON object.');
  }
  const fields = input as Record<string, unknown>;
  const problem = metadataProblem(fields);
  if (problem) return oauthError(400, 'invalid_client_metadata', problem);

  try {
    const client = await registerClient(
      await deps.getStore(),
      { name: (fields.client_name as string | undefined) ?? '', redirectUris: fields.redirect_uris as string[] },
      deps.nowSeconds,
    );
    return {
      statusCode: 201,
      headers: NO_STORE,
      body: JSON.stringify({
        client_id: client.clientId,
        client_id_issued_at: client.createdAt,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: GRANT_TYPES,
        response_types: RESPONSE_TYPES,
      }),
    };
  } catch (error) {
    if (error instanceof InvalidRedirectError) return oauthError(400, 'invalid_redirect_uri', error.message);
    if (error instanceof ClientLimitError) {
      console.warn('OAuth client registration refused: client limit reached');
      return oauthError(503, 'temporarily_unavailable', 'Registration is unavailable right now.');
    }
    throw error;
  }
}

function contentType(event: APIGatewayProxyEventV2): string {
  const header = Object.entries(event.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  return header.split(';')[0].trim().toLowerCase();
}

type FormResult = { fields: Map<string, string> } | { failure: ApiResponse };

// The body is checked for size before it is parsed. A repeated parameter is refused rather than resolved either way.
function parseForm(event: APIGatewayProxyEventV2): FormResult {
  if (contentType(event) !== 'application/x-www-form-urlencoded') {
    return { failure: oauthError(415, 'invalid_request', 'The body must be application/x-www-form-urlencoded.') };
  }
  const body = requestBody(event);
  if (Buffer.byteLength(body, 'utf8') > MAX_FORM_BODY_BYTES) {
    return { failure: oauthError(413, 'invalid_request', 'Request body is too large.') };
  }
  const fields = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(body)) {
    if (fields.has(name)) return { failure: oauthError(400, 'invalid_request', 'A parameter was repeated.') };
    fields.set(name, value);
  }
  return { fields };
}

const TOKEN_NO_STORE = { ...NO_STORE, Pragma: 'no-cache' };

const INVALID_GRANT = (): ApiResponse => oauthError(400, 'invalid_grant', 'The grant is invalid, expired or already used.');
const INVALID_CLIENT = (): ApiResponse => oauthError(401, 'invalid_client', 'Unknown client. Register again.');

function tokenResponse(tokens: { accessToken: string; refreshToken: string; expiresIn: number }, scope: string): ApiResponse {
  return {
    statusCode: 200,
    headers: TOKEN_NO_STORE,
    body: JSON.stringify({
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope,
    }),
  };
}

function verifierMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier)) return false;
  const expected = Buffer.from(challenge, 'utf8');
  const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'), 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// A client in use must not expire: this extends it on every successful grant (one small write each time). It runs after
// the tokens are issued, so it is best effort: a failure here must never lose them or make a retry look like a replay.
async function keepClientAlive(store: Store, clientId: string, nowSeconds: number): Promise<void> {
  try {
    await touchClient(store, clientId, nowSeconds);
  } catch (error) {
    console.warn('OAuth client expiry update failed:', clientId, error instanceof Error ? error.name : 'Error');
  }
}

async function exchangeCode(store: Store, fields: Map<string, string>, nowSeconds: number): Promise<ApiResponse> {
  const code = fields.get('code');
  const redirectUri = fields.get('redirect_uri');
  const clientId = fields.get('client_id');
  const verifier = fields.get('code_verifier');
  if (!code || !redirectUri || !clientId || !verifier) {
    return oauthError(400, 'invalid_request', 'code, redirect_uri, client_id and code_verifier are required.');
  }
  // The code is spent before anything else is checked, so any attempt burns it, even one with an unknown client.
  const stored = await consumeCode(store, code, nowSeconds);
  const client = await getClient(store, clientId, nowSeconds);
  if (!client) return INVALID_CLIENT();
  if (!stored || stored.clientId !== clientId || stored.redirectUri !== redirectUri || !verifierMatches(verifier, stored.codeChallenge)) {
    return INVALID_GRANT();
  }
  try {
    const connection = await createConnection(
      store, { userId: stored.userId, clientId, clientName: client.name, scope: stored.scope }, nowSeconds,
    );
    await keepClientAlive(store, clientId, nowSeconds);
    return tokenResponse(connection, stored.scope);
  } catch (error) {
    if (error instanceof TokenLimitError) {
      return oauthError(400, 'invalid_grant', 'Too many connections or tokens. Remove one in Settings and connect again.');
    }
    throw error;
  }
}

async function refreshTokens(store: Store, fields: Map<string, string>, nowSeconds: number): Promise<ApiResponse> {
  const refreshToken = fields.get('refresh_token');
  const clientId = fields.get('client_id');
  if (!refreshToken || !clientId) return oauthError(400, 'invalid_request', 'refresh_token and client_id are required.');
  if (!(await getClient(store, clientId, nowSeconds))) return INVALID_CLIENT();

  const rotated = await rotateConnection(store, refreshToken, clientId, nowSeconds);
  if (rotated === 'invalid' || rotated === 'reused') return INVALID_GRANT();
  await keepClientAlive(store, clientId, nowSeconds);
  return tokenResponse(rotated, rotated.scope);
}

async function token(event: APIGatewayProxyEventV2, deps: OauthPublicDeps): Promise<ApiResponse> {
  const sourceIp = event.requestContext.http.sourceIp;
  const parsed = parseForm(event);
  // A refresh needs a 256-bit secret and costs a bad grant up to three indexed reads and one hash, so it is neither blocked nor counted: a shared
  // address (a hosted client's backend) must not lock out other people's refreshes. On AWS the gateway throttle bounds
  // them; in the container only the cheapness of each request does.
  if ('fields' in parsed && parsed.fields.get('grant_type') === 'refresh_token') return tokenOutcome(parsed, deps);
  if (deps.tokenLimiter.isBlocked(sourceIp)) return tooManyTokenRequests();

  const response = await tokenOutcome(parsed, deps);
  // Caller errors that reach nothing (wrong content type, oversize) are not guesses and are not counted.
  if (response.statusCode >= 400 && response.statusCode !== 413 && response.statusCode !== 415) {
    deps.tokenLimiter.recordFailure(sourceIp);
    if (deps.tokenLimiter.isBlocked(sourceIp)) return tooManyTokenRequests();
  }
  return response;
}

function tooManyTokenRequests(): ApiResponse {
  return oauthError(429, 'too_many_requests', 'Too many failed requests. Try again later.', { 'Retry-After': TOKEN_RETRY_AFTER_SECONDS });
}

async function tokenOutcome(parsed: FormResult, deps: OauthPublicDeps): Promise<ApiResponse> {
  if ('failure' in parsed) return parsed.failure;
  const grantType = parsed.fields.get('grant_type');
  if (!grantType) return oauthError(400, 'invalid_request', 'grant_type is required.');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return oauthError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
  }
  const store = await deps.getStore();
  return grantType === 'authorization_code'
    ? exchangeCode(store, parsed.fields, deps.nowSeconds)
    : refreshTokens(store, parsed.fields, deps.nowSeconds);
}

interface ConnectionRef {
  userId: string;
  tokenId: string;
}

// Only a connection made through sign-in can be found here: a personal token has no kind, so this public route cannot revoke it.
async function findConnection(store: Store, value: string): Promise<ConnectionRef | undefined> {
  const hash = hashToken(value);
  if (TOKEN_PATTERN.test(value)) {
    const row = await store.get({ PK: LOOKUP_PK, SK: hash });
    if (row?.kind === 'oauth') return { userId: String(row.userId), tokenId: String(row.tokenId) };
  }
  const refresh = (await store.get({ PK: REFRESH_PK, SK: hash })) ?? (await store.get({ PK: REFRESH_USED_PK, SK: hash }));
  if (refresh) return { userId: String(refresh.userId), tokenId: String(refresh.tokenId) };
  return undefined;
}

async function revoke(event: APIGatewayProxyEventV2, deps: OauthPublicDeps): Promise<ApiResponse> {
  const sourceIp = event.requestContext.http.sourceIp;
  if (deps.revokeLimiter.isBlocked(sourceIp)) return tooManyTokenRequests();
  deps.revokeLimiter.recordFailure(sourceIp);

  const parsed = parseForm(event);
  if ('failure' in parsed) return parsed.failure;
  const value = parsed.fields.get('token');
  if (!value) return oauthError(400, 'invalid_request', 'token is required.');

  const store = await deps.getStore();
  const connection = await findConnection(store, value);
  if (connection) {
    const clientId = parsed.fields.get('client_id');
    const listing = await store.get({ PK: listingPk(connection.userId), SK: connection.tokenId });
    // A caller naming a client may only revoke that client's connection.
    if (!clientId || listing?.clientId === clientId) await revokeToken(store, connection.userId, connection.tokenId);
  }
  return { statusCode: 200, headers: NO_STORE, body: '{}' };
}

export function isOauthPublicPath(path: string): boolean {
  return path === REGISTER_PATH || path === TOKEN_PATH || path === REVOKE_PATH || path in DISCOVERY;
}

// Public OAuth routes, served ahead of any authentication. Returns undefined for any other path.
export async function handleOauthPublic(event: APIGatewayProxyEventV2, deps: OauthPublicDeps): Promise<ApiResponse | undefined> {
  const path = event.rawPath;
  const document = DISCOVERY[path];
  if (!document && path !== REGISTER_PATH && path !== TOKEN_PATH && path !== REVOKE_PATH) return undefined;
  if (!deps.origin) return err(404, 'Not found');

  const method = event.requestContext.http.method;
  if (document) {
    if (method !== 'GET') return methodNotAllowed('GET');
    const sourceIp = event.requestContext.http.sourceIp;
    deps.discoveryLimiter.recordFailure(sourceIp);
    if (deps.discoveryLimiter.isBlocked(sourceIp)) {
      return oauthError(429, 'too_many_requests', 'Too many requests. Try again later.', { 'Retry-After': '60' });
    }
    return {
      statusCode: 200,
      headers: { ...SECURITY_HEADERS, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify(document(deps.origin)),
    };
  }
  if (method !== 'POST') return methodNotAllowed('POST');
  if (path === TOKEN_PATH) return token(event, deps);
  if (path === REVOKE_PATH) return revoke(event, deps);
  return register(event, deps);
}
