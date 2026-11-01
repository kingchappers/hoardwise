import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { SECURITY_HEADERS } from '../api/constants';
import { err } from '../api/http';
import type { ApiResponse } from '../api/types';
import type { FailureLimiter } from '../auth/failureLimiter';
import type { Store } from '../store';
import { ClientLimitError, InvalidRedirectError, registerClient } from './clients';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';

export interface OauthPublicDeps {
  // Only registration needs the store, so it is opened lazily: discovery never depends on it.
  getStore: () => Promise<Store>;
  origin: string | undefined;
  limiter: FailureLimiter;
  // Counts every discovery request per address (60 a minute in the handler), apart from the registration limiter.
  discoveryLimiter: FailureLimiter;
  nowSeconds: number;
}

const REGISTER_PATH = '/api/oauth/register';
const MAX_REGISTER_BODY_BYTES = 8 * 1024;
const RETRY_AFTER_SECONDS = '3600';
const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const RESPONSE_TYPES = ['code'];
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
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== 'none') {
    return 'Only token_endpoint_auth_method "none" is supported';
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

export function isOauthPublicPath(path: string): boolean {
  return path === REGISTER_PATH || path in DISCOVERY;
}

// Public OAuth routes, served ahead of any authentication. Returns undefined for any other path.
export async function handleOauthPublic(event: APIGatewayProxyEventV2, deps: OauthPublicDeps): Promise<ApiResponse | undefined> {
  const path = event.rawPath;
  const document = DISCOVERY[path];
  if (!document && path !== REGISTER_PATH) return undefined;
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
  return register(event, deps);
}
