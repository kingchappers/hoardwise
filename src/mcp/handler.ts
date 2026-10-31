import type { AuthInfo } from '@modelcontextprotocol/server';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { SECURITY_HEADERS } from '../api/constants';
import { err } from '../api/http';
import type { ApiResponse } from '../api/types';
import { authenticateToken } from '../auth/tokenAuth';
import { touchToken } from '../auth/tokens';
import type { FailureLimiter } from '../auth/failureLimiter';
import type { Store } from '../store';
import { createRequestLimiter } from './rateLimit';
import { createMcpEndpoint } from './sdkServer';
import type { McpEndpoint } from './sdkServer';
import { MCP_MAX_BODY_BYTES } from './types';
import type { McpTool } from './types';

const REQUESTS_PER_MINUTE = 60;
const requestLimiter = createRequestLimiter({ limit: REQUESTS_PER_MINUTE, windowSeconds: 60 });
const HEADERS: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
// Only these request headers reach the SDK: never Authorization or Cookie.
const FORWARDED_HEADERS = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name'];

// One endpoint per tool list, so the SDK handler is built once per module load, not per request.
const endpoints = new WeakMap<McpTool[], McpEndpoint>();

export interface McpDeps {
  store: Store;
  now: Date;
  tokenFailures: FailureLimiter;
}

function tooManyRequests(): ApiResponse {
  const response = err(429, 'Too many requests');
  return { ...response, headers: { ...response.headers, 'Retry-After': '60' } };
}

function endpointFor(tools: McpTool[]): McpEndpoint {
  let endpoint = endpoints.get(tools);
  if (!endpoint) {
    endpoint = createMcpEndpoint(tools);
    endpoints.set(tools, endpoint);
  }
  return endpoint;
}

function sdkRequest(event: APIGatewayProxyEventV2, body: string | undefined): Request {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = event.headers?.[name];
    if (value !== undefined) headers.set(name, value);
  }
  return new Request('http://localhost/mcp', { method: 'POST', headers, body: body ?? '' });
}

async function serveMcp(event: APIGatewayProxyEventV2, tools: McpTool[], authInfo: AuthInfo): Promise<ApiResponse> {
  const body = requestBody(event);
  if (body !== undefined && Buffer.byteLength(body, 'utf8') > MCP_MAX_BODY_BYTES) {
    return { statusCode: 413, headers: HEADERS, body: JSON.stringify({ error: 'Request body is too large.' }) };
  }
  try {
    const response = await endpointFor(tools)(sdkRequest(event, body), { authInfo });
    return { statusCode: response.status, headers: HEADERS, body: await response.text() };
  } catch (error) {
    // Name only, and no detail in the reply: SDK errors can quote the request.
    console.error('mcp request failed', { error: error instanceof Error ? error.name : 'unknown' });
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error.' } }) };
  }
}

function requestBody(event: APIGatewayProxyEventV2): string | undefined {
  if (event.body === undefined) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

// Only an access token is accepted here, and scope is enforced per tool, so tokenAccessRejection is not used.
export async function handleMcpRequest(event: APIGatewayProxyEventV2, tools: McpTool[], deps: McpDeps): Promise<ApiResponse> {
  if (event.requestContext.http.method !== 'POST') {
    return { ...err(405, 'Method not allowed'), headers: { ...SECURITY_HEADERS, Allow: 'POST' } };
  }
  // Browsers never call this endpoint; refusing an Origin blocks DNS rebinding.
  if (event.headers?.origin !== undefined) return err(403, 'Forbidden');

  const sourceIp = event.requestContext.http.sourceIp;
  if (deps.tokenFailures.isBlocked(sourceIp)) return tooManyRequests();

  const nowSeconds = Math.floor(deps.now.getTime() / 1000);
  const result = await authenticateToken(event, deps.store, nowSeconds);
  if ('rejection' in result) {
    deps.tokenFailures.recordFailure(sourceIp);
    if (deps.tokenFailures.isBlocked(sourceIp)) return tooManyRequests();
    return result.rejection;
  }

  if (!requestLimiter.allow(result.userId, nowSeconds)) return tooManyRequests();

  try {
    await touchToken(deps.store, result.stored, nowSeconds);
  } catch (error) {
    console.warn('Token last-used update failed:', error instanceof Error ? error.name : 'Error');
  }
  // The SDK gets the token's id, never the token itself.
  const authInfo: AuthInfo = { token: '', clientId: result.stored.tokenId, scopes: [result.scope], extra: { userId: result.userId } };
  return serveMcp(event, tools, authInfo);
}
