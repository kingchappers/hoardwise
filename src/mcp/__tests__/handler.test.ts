import type { AuthInfo } from '@modelcontextprotocol/server';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToken, listTokens } from '../../auth/tokens';
import { createFailureLimiter } from '../../auth/failureLimiter';
import { setStore } from '../../store';
import { MemoryStore } from '../../store/memory';
import type { ApiResponse } from '../../api/types';
import { handleMcpRequest } from '../handler';
import { createMcpEndpoint } from '../sdkServer';
import type { McpTool } from '../types';

// The SDK side is replaced, so these tests see exactly what handler.ts hands to it and what it does with the reply.
vi.mock('../sdkServer', () => ({ createMcpEndpoint: vi.fn() }));

const endpoint = vi.fn<(request: Request, options: { authInfo: AuthInfo }) => Promise<Response>>();
let store: MemoryStore;

const INTERNAL_ERROR = { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error.' } };
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

function makeEvent(headers: Record<string, string>): APIGatewayProxyEventV2 {
  return {
    rawPath: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: LIST,
    isBase64Encoded: false,
    requestContext: { routeKey: 'ANY /mcp', http: { method: 'POST', sourceIp: '192.0.2.1' } },
  } as unknown as APIGatewayProxyEventV2;
}

async function send(headers: Record<string, string> = {}): Promise<{ res: ApiResponse; token: string }> {
  const { token } = await createToken(store, { userId: 'user-a', name: 'agent', scope: 'read', expiryDays: 90 }, Math.floor(Date.now() / 1000));
  // A new tool list each time, so handler.ts builds a new endpoint through the mock.
  const tools: McpTool[] = [];
  const res = await handleMcpRequest(makeEvent({ authorization: `Bearer ${token}`, ...headers }), tools, {
    store,
    now: new Date(),
    tokenFailures: createFailureLimiter(),
  });
  return { res, token };
}

beforeEach(() => {
  store = new MemoryStore();
  setStore(store);
  endpoint.mockReset();
  endpoint.mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200 }));
  vi.mocked(createMcpEndpoint).mockReturnValue(endpoint);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setStore(undefined);
  vi.restoreAllMocks();
});

describe('what reaches the SDK', () => {
  it('passes neither the token nor the cookie nor the client address, only the stored token id', async () => {
    const { token } = await send({ cookie: 'session=secret-cookie', 'x-forwarded-for': '198.51.100.7' });

    expect(endpoint).toHaveBeenCalledTimes(1);
    const [request, { authInfo }] = endpoint.mock.calls[0];
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('cookie')).toBe(false);
    expect(request.headers.has('x-forwarded-for')).toBe(false);
    expect(authInfo.token).toBe('');
    expect(JSON.stringify(authInfo)).not.toContain(token);
    const [stored] = await listTokens(store, 'user-a');
    expect(authInfo.clientId).toBe(stored.tokenId);
  });
});

describe('SDK replies that carry nothing for the client', () => {
  it.each([
    ['an empty 499', new Response(null, { status: 499 })],
    ['a 500 with SDK text', new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom at line 3' } }), { status: 500 })],
    ['an empty 400', new Response(null, { status: 400 })],
  ])('maps %s to a 200 JSON -32603', async (_label, response) => {
    endpoint.mockResolvedValue(response);
    const { res } = await send();
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Content-Type']).toMatch(/^application\/json/);
    expect(JSON.parse(res.body)).toEqual(INTERNAL_ERROR);
  });

  it('keeps an empty 202 for a notification', async () => {
    endpoint.mockResolvedValue(new Response(null, { status: 202 }));
    const { res } = await send();
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });
});
