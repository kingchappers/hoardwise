import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { handler } from '../../../api-handler';
import { setAuth } from '../../auth';
import type { AuthResult } from '../../auth';
import { createToken, listTokens, revokeToken } from '../../auth/tokens';
import type { TokenScope } from '../../auth/tokens';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { createFailureLimiter } from '../../auth/failureLimiter';
import { handleMcpRequest } from '../handler';
import { MCP_TOOLS } from '../tools';
import { PRIVACY_NOTE, READ_ONLY } from '../tools/shared';
import type { McpTool, ToolOutcome } from '../types';
import { setStore } from '../../store';
import { MemoryStore } from '../../store/memory';
import type { ApiResponse } from '../../api/types';

let store: MemoryStore;
let fakeAuth: {
  mode: 'auth0';
  authenticate: Mock<(event: APIGatewayProxyEventV2) => Promise<AuthResult>>;
  handlePublic: Mock<(event: APIGatewayProxyEventV2) => Promise<ApiResponse | undefined>>;
};
let ipCounter = 0;

const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

interface EventOptions {
  method?: string;
  path?: string;
  authorization?: string;
  cookie?: string;
  origin?: string;
  extraHeaders?: Record<string, string>;
  body?: string;
  base64?: boolean;
  sourceIp?: string;
}

function makeEvent(options: EventOptions = {}): APIGatewayProxyEventV2 {
  ipCounter += 1;
  const { method = 'POST', path = '/mcp', authorization, cookie, origin, extraHeaders = {}, body = LIST, base64 = false, sourceIp = `203.0.113.${ipCounter}` } = options;
  // What a Streamable HTTP client sends with every POST.
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extraHeaders };
  if (authorization !== undefined) headers.authorization = authorization;
  if (cookie !== undefined) headers.cookie = cookie;
  if (origin !== undefined) headers.origin = origin;
  return {
    rawPath: path,
    headers,
    body: base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: base64,
    requestContext: { routeKey: 'ANY /mcp', http: { method, sourceIp } },
  } as unknown as APIGatewayProxyEventV2;
}

async function invoke(event: APIGatewayProxyEventV2): Promise<ApiResponse> {
  return (await handler(event, {} as Context, () => {})) as ApiResponse;
}

async function tokenFor(userId: string, scope: TokenScope, expiryDays = 90): Promise<string> {
  const { token } = await createToken(store, { userId, name: 'agent', scope, expiryDays }, Math.floor(Date.now() / 1000));
  return token;
}

beforeEach(() => {
  store = new MemoryStore();
  setStore(store);
  fakeAuth = {
    mode: 'auth0',
    authenticate: vi.fn<(event: APIGatewayProxyEventV2) => Promise<AuthResult>>().mockResolvedValue({ userId: 'jwt-user' }),
    handlePublic: vi.fn<(event: APIGatewayProxyEventV2) => Promise<ApiResponse | undefined>>().mockResolvedValue(undefined),
  };
  setAuth(fakeAuth);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setAuth(undefined);
  setStore(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('POST /mcp authentication', () => {
  it('answers tools/list for a read token', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(200);
    const names = JSON.parse(res.body).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['month_review', 'category_detail', 'pots_overview', 'chart_data', 'display_guidance']);
  });

  it('decodes a base64 body', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, base64: true }));
    expect(JSON.parse(res.body).result.tools).toHaveLength(MCP_TOOLS.length);
  });

  it('answers 401 to a session cookie alone and never calls the auth provider', async () => {
    const res = await invoke(makeEvent({ cookie: 'hw_session=abc' }));
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('{"error":"Unauthorized"}');
    expect(fakeAuth.authenticate).not.toHaveBeenCalled();
    expect(fakeAuth.handlePublic).not.toHaveBeenCalled();
  });

  it('answers 401 with no Authorization header', async () => {
    expect((await invoke(makeEvent())).statusCode).toBe(401);
  });

  it('answers 401 to a revoked token', async () => {
    const token = await tokenFor('user-a', 'read');
    const [record] = await listTokens(store, 'user-a');
    await revokeToken(store, 'user-a', record.tokenId);
    expect((await invoke(makeEvent({ authorization: `Bearer ${token}` }))).statusCode).toBe(401);
  });

  it('answers 401 to an expired token', async () => {
    const token = await tokenFor('user-a', 'read', 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    expect((await invoke(makeEvent({ authorization: `Bearer ${token}` }))).statusCode).toBe(401);
  });

  it('still counts repeated bad tokens against the failure limiter', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      statuses.push((await invoke(makeEvent({ authorization: 'Bearer hwr_nope', sourceIp: '192.0.2.77' }))).statusCode);
    }
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
  });
});

describe('POST /mcp request rules', () => {
  it('answers 405 with Allow: POST to GET and DELETE', async () => {
    const token = await tokenFor('user-a', 'read');
    for (const method of ['GET', 'DELETE']) {
      const res = await invoke(makeEvent({ method, authorization: `Bearer ${token}` }));
      expect(res.statusCode).toBe(405);
      expect(res.headers?.Allow).toBe('POST');
    }
  });

  it('answers 403 to a request that carries an Origin header', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, origin: 'http://evil.example' }));
    expect(res.statusCode).toBe(403);
  });

  it('answers 413 to a body over 65,536 bytes', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, body: 'x'.repeat(65_537) }));
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body is too large.' });
  });

  it('answers 429 with Retry-After on the 61st request in a minute, for that user only', async () => {
    const tokenA = await tokenFor('rate-a', 'read');
    const tokenB = await tokenFor('rate-b', 'read');
    for (let i = 0; i < 60; i += 1) {
      expect((await invoke(makeEvent({ authorization: `Bearer ${tokenA}` }))).statusCode).toBe(200);
    }
    const limited = await invoke(makeEvent({ authorization: `Bearer ${tokenA}` }));
    expect(limited.statusCode).toBe(429);
    expect(limited.headers?.['Retry-After']).toBe('60');
    expect((await invoke(makeEvent({ authorization: `Bearer ${tokenB}` }))).statusCode).toBe(200);
  });
});

describe('token rules elsewhere are unchanged', () => {
  it('a read token still cannot POST to /api/transactions', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ path: '/api/transactions', authorization: `Bearer ${token}`, body: '{}' }));
    expect(res.statusCode).toBe(403);
  });

  it('a token cannot reach /api/tokens', async () => {
    const token = await tokenFor('user-a', 'write');
    const res = await invoke(makeEvent({ method: 'GET', path: '/api/tokens', authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(403);
  });
});

function rpc(method: string, params?: Record<string, unknown>, id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
}

function callTool(name: string, args: Record<string, unknown> = {}): string {
  return rpc('tools/call', { name, arguments: args });
}

async function invokeWith(tools: McpTool[], body: string, scope: TokenScope = 'read'): Promise<ApiResponse> {
  const token = await tokenFor('user-a', scope);
  return handleMcpRequest(makeEvent({ authorization: `Bearer ${token}`, body }), tools, {
    store,
    now: new Date(),
    tokenFailures: createFailureLimiter(),
  });
}

function fakeTool(name: string, overrides: Partial<McpTool> = {}): McpTool {
  return {
    name,
    title: name,
    description: `The ${name} tool.`,
    access: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    run: async (): Promise<ToolOutcome> => ({ ok: true, data: { done: true } }),
    ...overrides,
  };
}

// Every line any console method was given, as one string, to check nothing private was logged.
function everythingLogged(): string {
  const spies = [console.log, console.error, console.warn] as unknown as Mock[];
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls), (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
  );
}

describe('POST /mcp through the SDK', () => {
  it('lists exactly the five read tools with their annotations and schemas, as one JSON reply', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}` }));
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Content-Type']).toMatch(/^application\/json/);
    expect(res.headers?.['Cache-Control']).toBe('no-store');
    expect(res.headers?.['X-Content-Type-Options']).toBe('nosniff');
    const listed = JSON.parse(res.body).result.tools;
    expect(listed).toEqual(
      MCP_TOOLS.map((t) =>
        expect.objectContaining({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }),
      ),
    );
  });

  it('lets a write token see the read tools too', async () => {
    const token = await tokenFor('user-a', 'write');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}` }));
    const names = JSON.parse(res.body).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(MCP_TOOLS.map((t) => t.name));
  });

  it('answers a 2025-06-18 initialize with that version, as one JSON reply', async () => {
    const token = await tokenFor('user-a', 'read');
    const body = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, body }));
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Content-Type']).toMatch(/^application\/json/);
    const result = JSON.parse(res.body).result;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.serverInfo.name).toBe('hoardwise');
  });

  it('answers a 2026-07-28 tools/list, as one JSON reply', async () => {
    const token = await tokenFor('user-a', 'read');
    const version = '2026-07-28';
    const meta = {
      [PROTOCOL_VERSION_META_KEY]: version,
      [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    };
    const res = await invoke(
      makeEvent({
        authorization: `Bearer ${token}`,
        body: rpc('tools/list', { _meta: meta }),
        extraHeaders: { 'mcp-protocol-version': version, 'mcp-method': 'tools/list' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Content-Type']).toMatch(/^application\/json/);
    const names = JSON.parse(res.body).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(MCP_TOOLS.map((t) => t.name));
  });

  it('answers a 2026-07-28 server/discover with the server name', async () => {
    const token = await tokenFor('user-a', 'read');
    const version = '2026-07-28';
    const meta = {
      [PROTOCOL_VERSION_META_KEY]: version,
      [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    };
    const res = await invoke(
      makeEvent({
        authorization: `Bearer ${token}`,
        body: rpc('server/discover', { _meta: meta }),
        extraHeaders: { 'mcp-protocol-version': version, 'mcp-method': 'server/discover' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('hoardwise');
  });

  it('refuses a 2026-07-28 subscriptions/listen promptly with one JSON reply instead of a stream', async () => {
    const token = await tokenFor('user-a', 'read');
    const version = '2026-07-28';
    const meta = {
      [PROTOCOL_VERSION_META_KEY]: version,
      [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    };
    const reply = invoke(
      makeEvent({
        authorization: `Bearer ${token}`,
        body: rpc('subscriptions/listen', { notifications: { toolsListChanged: true }, _meta: meta }),
        extraHeaders: { 'mcp-protocol-version': version, 'mcp-method': 'subscriptions/listen' },
      }),
    );
    const timedOut = new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 2000));
    const res = await Promise.race([reply, timedOut]);
    expect(res).not.toBe('timed out');
    const response = res as ApiResponse;
    expect(response.headers?.['Content-Type']).toMatch(/^application\/json/);
    expect(JSON.parse(response.body)).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found.' } });
  });

  it('refuses resources/subscribe before the SDK', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, body: rpc('resources/subscribe', { uri: 'x://y' }) }));
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found.' } });
  });

  it('returns month_review as text and structuredContent with the privacy note', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, body: callTool('month_review', { month: '2026-09' }) }));
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body).result;
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
    expect(result.structuredContent).toMatchObject({ note: PRIVACY_NOTE, unit: 'pence', month: '2026-09' });
  });

  it("keeps a tool's own message for input it refuses", async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, body: callTool('month_review', { month: '2026-13' }) }));
    expect(JSON.parse(res.body).result).toEqual({ content: [{ type: 'text', text: 'month must be YYYY-MM' }], isError: true });
  });

  it('answers 406 with a fixed message to a client that cannot accept the Streamable HTTP reply types', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, extraHeaders: { accept: 'application/json' } }));
    expect(res.statusCode).toBe(406);
    expect(JSON.parse(res.body).error).toEqual({ code: -32000, message: 'Accept must include application/json and text/event-stream.' });
  });

  it('refuses a JSON-RPC batch', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, body: `[${LIST}]` }));
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported.' } });
  });

  it('answers an unknown tool with an error that does not echo the name', async () => {
    const token = await tokenFor('user-a', 'read');
    const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, body: callTool('secret_payee_tool') }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).error.code).toBe(-32602);
    expect(res.body).not.toContain('secret_payee_tool');
  });

  it('runs a tool as the token\'s user with the token\'s scope', async () => {
    const seen: unknown[] = [];
    const spy = fakeTool('spy', {
      run: async (_args, context) => {
        seen.push(context);
        return { ok: true, data: {} };
      },
    });
    await invokeWith([spy], callTool('spy'));
    expect(seen).toEqual([expect.objectContaining({ userId: 'user-a', scope: 'read' })]);
  });
});

describe('POST /mcp tool rules through the SDK', () => {
  it('neither lists nor runs a budget tool for a read token', async () => {
    const run = vi.fn(async (): Promise<ToolOutcome> => ({ ok: true, data: {} }));
    const budgetTool = fakeTool('set_target', { access: 'budget', run });
    const tools = [fakeTool('read_tool'), budgetTool];

    const listed = JSON.parse((await invokeWith(tools, LIST)).body).result.tools.map((t: { name: string }) => t.name);
    expect(listed).toEqual(['read_tool']);

    const called = JSON.parse((await invokeWith(tools, callTool('set_target'))).body);
    expect(called.error?.code ?? (called.result?.isError ? 'isError' : 'ok')).not.toBe('ok');
    expect(run).not.toHaveBeenCalled();
  });

  it('lists and runs a budget tool for a write token', async () => {
    const tools = [fakeTool('read_tool'), fakeTool('set_target', { access: 'budget' })];
    const listed = JSON.parse((await invokeWith(tools, LIST, 'write')).body).result.tools.map((t: { name: string }) => t.name);
    expect(listed).toEqual(['read_tool', 'set_target']);
    expect(JSON.parse((await invokeWith(tools, callTool('set_target'), 'write')).body).result.structuredContent).toEqual({ done: true });
  });

  it('turns a throwing tool into a generic tool error and logs only the tool name and error class', async () => {
    const thrower = fakeTool('thrower', {
      run: async () => {
        throw new TypeError('payee Tesco description private-detail');
      },
    });
    const res = await invokeWith([thrower], callTool('thrower', { month: 'arg-value-xyz' }));
    expect(JSON.parse(res.body).result).toEqual({ content: [{ type: 'text', text: 'That request failed. Please try again.' }], isError: true });
    expect(console.error).toHaveBeenCalledWith('mcp tool failed', { tool: 'thrower', error: 'TypeError' });
    const logged = everythingLogged();
    expect(logged).not.toContain('private-detail');
    expect(logged).not.toContain('arg-value-xyz');
  });

  it('turns a result over 200,000 characters into a tool error', async () => {
    const huge = fakeTool('huge', { run: async () => ({ ok: true, data: { text: 'x'.repeat(200_000) } }) });
    const result = JSON.parse((await invokeWith([huge], callTool('huge'))).body).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/too large/);
  });

  it('turns an unserialisable result into a tool error', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const loop = fakeTool('loop', { run: async () => ({ ok: true, data: cyclic }) });
    const result = JSON.parse((await invokeWith([loop], callTool('loop'))).body).result;
    expect(result).toEqual({ content: [{ type: 'text', text: 'That request failed. Please try again.' }], isError: true });
  });

  it('never puts an SDK error message or a value from the request into the reply or a log line', async () => {
    const token = await tokenFor('user-a', 'read');
    const bodies = [
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"month_review","arguments":"private-arg"}}',
      '{"jsonrpc":"2.0","id":1,"method":"private-method"}',
      '{not json private-text',
    ];
    for (const body of bodies) {
      const res = await invoke(makeEvent({ authorization: `Bearer ${token}`, body }));
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toContain('private');
    }
    expect(everythingLogged()).not.toContain('private');
  });
});
