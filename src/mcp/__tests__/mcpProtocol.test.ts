import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { createToken } from '../../auth/tokens';
import type { TokenScope } from '../../auth/tokens';
import { createFailureLimiter } from '../../auth/failureLimiter';
import { handleMcpRequest } from '../handler';
import { READ_ONLY } from '../tools/shared';
import type { McpTool, ToolOutcome } from '../types';
import { setStore } from '../../store';
import { MemoryStore } from '../../store/memory';
import type { ApiResponse } from '../../api/types';

// Protocol behaviour of /mcp, driven through the real request handler with a real token.
// Asserts what clients and the privacy rules depend on (codes, isError, no leaks), not SDK wording.

let store: MemoryStore;
let ipCounter = 0;

function makeEvent(body: string, token: string): APIGatewayProxyEventV2 {
  ipCounter += 1;
  return {
    rawPath: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body,
    isBase64Encoded: false,
    requestContext: { routeKey: 'ANY /mcp', http: { method: 'POST', sourceIp: `198.51.100.${ipCounter}` } },
  } as unknown as APIGatewayProxyEventV2;
}

function fakeTool(name: string, overrides: Partial<McpTool> = {}): McpTool {
  return {
    name,
    title: name,
    description: `The ${name} tool.`,
    access: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    run: async (args): Promise<ToolOutcome> => ({ ok: true, data: { echoed: args } }),
    ...overrides,
  };
}

async function send(body: string, tools: McpTool[] = [fakeTool('echo')], scope: TokenScope = 'read'): Promise<ApiResponse> {
  const { token } = await createToken(store, { userId: 'user-a', name: 'agent', scope, expiryDays: 90 }, Math.floor(Date.now() / 1000));
  return handleMcpRequest(makeEvent(body, token), tools, { store, now: new Date(), tokenFailures: createFailureLimiter() });
}

function rpc(method: string, params?: Record<string, unknown>, id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
}

const callTool = (name: string, args?: unknown): string => rpc('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });

function everythingLogged(): string {
  const spies = [console.log, console.warn, console.error, console.info] as unknown as Mock[];
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls), (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
  );
}

const json = (res: ApiResponse): any => JSON.parse(res.body);

beforeEach(() => {
  store = new MemoryStore();
  setStore(store);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setStore(undefined);
  vi.restoreAllMocks();
});

describe('initialize and discovery', () => {
  const init = (version: string) => send(rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } }));

  it.each(['2025-06-18', '2025-03-26'])('answers initialize for %s with a supported version, tools and the server name', async (version) => {
    const res = await init(version);
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Content-Type']).toMatch(/^application\/json/);
    const result = json(res).result;
    expect(typeof result.protocolVersion).toBe('string');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe('hoardwise');
  });

  it('answers initialize for an unsupported version with a version it does support, not an error', async () => {
    const res = await init('1999-01-01');
    expect(res.statusCode).toBe(200);
    expect(json(res).result.protocolVersion).not.toBe('1999-01-01');
  });

  it('answers a 2026-07-28 server/discover', async () => {
    const version = '2026-07-28';
    const meta = { [PROTOCOL_VERSION_META_KEY]: version, [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' }, [CLIENT_CAPABILITIES_META_KEY]: {} };
    const { token } = await createToken(store, { userId: 'user-a', name: 'agent', scope: 'read', expiryDays: 90 }, Math.floor(Date.now() / 1000));
    const event = makeEvent(rpc('server/discover', { _meta: meta }), token);
    event.headers['mcp-protocol-version'] = version;
    event.headers['mcp-method'] = 'server/discover';
    const res = await handleMcpRequest(event, [fakeTool('echo')], { store, now: new Date(), tokenFailures: createFailureLimiter() });
    expect(res.statusCode).toBe(200);
    expect(json(res).result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('hoardwise');
  });
});

describe('simple methods', () => {
  it('answers notifications/initialized with 202 and an empty body', async () => {
    const res = await send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('answers ping with an empty result', async () => {
    const res = await send(rpc('ping', undefined, 'a'));
    expect(json(res)).toEqual({ jsonrpc: '2.0', id: 'a', result: {} });
  });
});

describe('tools/list scope', () => {
  const tools = (): McpTool[] => [fakeTool('echo'), fakeTool('spend', { access: 'budget' })];
  const names = (res: ApiResponse): string[] => json(res).result.tools.map((t: { name: string }) => t.name);

  it('lists name, title, description, inputSchema and annotations', async () => {
    const tool = fakeTool('echo');
    expect(json(await send(rpc('tools/list'), [tool])).result.tools).toEqual([
      expect.objectContaining({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }),
    ]);
  });

  it('hides a budget tool from a read token', async () => {
    expect(names(await send(rpc('tools/list'), tools(), 'read'))).toEqual(['echo']);
  });

  it('shows a budget tool to a write token', async () => {
    expect(names(await send(rpc('tools/list'), tools(), 'write'))).toEqual(['echo', 'spend']);
  });
});

describe('tools/call', () => {
  it('returns text content plus structuredContent', async () => {
    const result = json(await send(callTool('echo', { a: 1 }))).result;
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ echoed: { a: 1 } }) }]);
    expect(result.structuredContent).toEqual({ echoed: { a: 1 } });
    expect(result.isError).toBeUndefined();
  });

  it('defaults missing arguments to an empty object', async () => {
    const run = vi.fn(async (): Promise<ToolOutcome> => ({ ok: true, data: {} }));
    await send(callTool('echo'), [fakeTool('echo', { run })]);
    expect(run).toHaveBeenCalledWith({}, expect.objectContaining({ userId: 'user-a', scope: 'read' }));
  });

  it('answers an unknown tool and an out-of-scope tool with the same -32602 and no name', async () => {
    const tools = [fakeTool('echo'), fakeTool('spend', { access: 'budget' })];
    const unknown = await send(callTool('secret_unknown'), tools);
    const outOfScope = await send(callTool('spend'), tools);
    expect(json(unknown).error.code).toBe(-32602);
    expect(json(outOfScope).error.code).toBe(-32602);
    expect(json(outOfScope).error.message).toBe(json(unknown).error.message.replace('secret_unknown', 'spend'));
    expect(unknown.body).not.toContain('secret_unknown');
  });

  it('runs a budget tool for a write token but never for a read token', async () => {
    const run = vi.fn(async (): Promise<ToolOutcome> => ({ ok: true, data: { done: true } }));
    const tools = [fakeTool('spend', { access: 'budget', run })];
    await send(callTool('spend'), tools, 'read');
    expect(run).not.toHaveBeenCalled();
    expect(json(await send(callTool('spend'), tools, 'write')).result.structuredContent).toEqual({ done: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong-typed arguments with an error that is not a 5xx', async () => {
    for (const args of ['x', 5, [1], null]) {
      const res = await send(callTool('echo', args));
      expect(res.statusCode).toBeLessThan(500);
      const body = json(res);
      expect(body.error?.code ?? (body.result?.isError ? 'isError' : 'ok')).not.toBe('ok');
    }
  });

  it('rejects missing or non-object params with an invalid-request or invalid-params error', async () => {
    for (const params of [undefined, 'x', [], { name: 5 }]) {
      const res = await send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', ...(params === undefined ? {} : { params }) }));
      expect(res.statusCode).toBeLessThan(500);
      expect([-32600, -32602]).toContain(json(res).error.code);
    }
  });

  it('keeps a tool\'s own message for { ok: false }', async () => {
    const tool = fakeTool('echo', { run: async () => ({ ok: false, message: 'Month must be YYYY-MM.' }) });
    const result = json(await send(callTool('echo'), [tool])).result;
    expect(result).toEqual({ content: [{ type: 'text', text: 'Month must be YYYY-MM.' }], isError: true });
  });

  it('turns a throw into a generic isError with no message, stack or argument anywhere', async () => {
    const tool = fakeTool('echo', {
      run: async () => {
        throw new TypeError('secret payee Acme');
      },
    });
    const res = await send(callTool('echo', { q: 'private-arg' }), [tool]);
    expect(json(res).result).toEqual({ content: [{ type: 'text', text: 'That request failed. Please try again.' }], isError: true });
    expect(res.body).not.toMatch(/Acme|private-arg|stack/);
    const logged = everythingLogged();
    expect(logged).toContain('echo');
    expect(logged).not.toMatch(/Acme|private-arg|stack/);
  });

  it.each([
    ['a BigInt', async () => ({ ok: true, data: { amount: BigInt(1) } })],
    ['undefined data', async () => ({ ok: true, data: undefined })],
    ['no outcome at all', async () => undefined],
  ])('turns %s into a generic isError without a message or argument', async (_label, run) => {
    const tool = fakeTool('echo', { run: run as unknown as McpTool['run'] });
    const res = await send(callTool('echo', { q: 'private-arg' }), [tool]);
    expect(res.statusCode).toBe(200);
    expect(json(res).result).toEqual({ content: [{ type: 'text', text: 'That request failed. Please try again.' }], isError: true });
    expect(res.body).not.toContain('private-arg');
    expect(everythingLogged()).not.toContain('private-arg');
  });

  it('turns a result over 200,000 characters into isError asking for a narrower request, with no data', async () => {
    const tool = fakeTool('echo', { run: async () => ({ ok: true, data: { big: 'x'.repeat(200_000) } }) });
    const res = await send(callTool('echo'), [tool]);
    const result = json(res).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/narrower/);
    expect(result.structuredContent).toBeUndefined();
    expect(res.body).not.toContain('xxxxxxxx');
  });

  it('treats a tools/call with no id as a notification and never runs the tool', async () => {
    const run = vi.fn(async (): Promise<ToolOutcome> => ({ ok: true, data: {} }));
    const res = await send(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo', arguments: {} } }), [fakeTool('echo', { run })]);
    expect(res.statusCode).toBeLessThan(500);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('malformed JSON-RPC', () => {
  // Each must answer with JSON-RPC error JSON (never a 5xx) and echo nothing the client sent.
  const refused: Array<[string, string]> = [
    ['invalid JSON', '{not json private-text'],
    ['a non-object body', '5'],
    ['a missing method', '{"jsonrpc":"2.0","id":1,"private":"private-text"}'],
    ['a non-string method', '{"jsonrpc":"2.0","id":1,"method":5,"private":"private-text"}'],
    ['an object id', '{"jsonrpc":"2.0","id":{"private":"private-text"},"method":"ping"}'],
    ['an unknown method', '{"jsonrpc":"2.0","id":3,"method":"private-method"}'],
    ['an empty body', ''],
  ];

  it.each(refused)('answers %s with a JSON-RPC error and echoes nothing', async (_label, body) => {
    const res = await send(body);
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.headers?.['Content-Type']).toMatch(/^application\/json/);
    expect(typeof json(res).error.code).toBe('number');
    expect(res.body).not.toContain('private');
    expect(everythingLogged()).not.toContain('private');
  });

  it('answers an unknown method with -32601 and keeps the id', async () => {
    const body = json(await send(rpc('bogus', undefined, 3)));
    expect(body.error.code).toBe(-32601);
    expect(body.id).toBe(3);
  });

  it('answers invalid JSON with -32700 and a non-object body with -32600', async () => {
    expect(json(await send('{nope')).error.code).toBe(-32700);
    expect(json(await send('5')).error.code).toBe(-32600);
  });

  it('refuses a JSON-RPC batch with -32600, before any request in it runs', async () => {
    const run = vi.fn(async (): Promise<ToolOutcome> => ({ ok: true, data: {} }));
    const res = await send(`[${callTool('echo')},${rpc('ping', undefined, 2)}]`, [fakeTool('echo', { run })]);
    expect(json(res).error.code).toBe(-32600);
    expect(Array.isArray(json(res))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('an exchange that never finishes', () => {
  const INTERNAL_ERROR = { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error.' } };
  const MODERN = '2026-07-28';

  function modernCall(token: string): APIGatewayProxyEventV2 {
    const meta = { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' }, [CLIENT_CAPABILITIES_META_KEY]: {} };
    const event = makeEvent(rpc('tools/call', { name: 'echo', arguments: { q: 'private-arg' }, _meta: meta }), token);
    event.headers['mcp-protocol-version'] = MODERN;
    event.headers['mcp-method'] = 'tools/call';
    event.headers['mcp-name'] = 'echo';
    return event;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['a 2025-06-18 (legacy) tools/call', (token: string) => makeEvent(callTool('echo', { q: 'private-arg' }), token)],
    ['a 2026-07-28 (modern) tools/call', modernCall],
  ])('answers %s whose tool hangs with a JSON -32603 after 25 s and leaves no timer behind', async (_label, eventFor) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hangs = fakeTool('echo', {
      run: () => {
        started();
        return new Promise<ToolOutcome>(() => {});
      },
    });
    const { token } = await createToken(store, { userId: 'user-a', name: 'agent', scope: 'read', expiryDays: 90 }, Math.floor(Date.now() / 1000));

    const reply = handleMcpRequest(eventFor(token), [hangs], { store, now: new Date(), tokenFailures: createFailureLimiter() });
    await running;
    await vi.advanceTimersByTimeAsync(25_000);
    const res = await reply;

    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Content-Type']).toMatch(/^application\/json/);
    expect(json(res)).toEqual(INTERNAL_ERROR);
    expect(vi.getTimerCount()).toBe(0);
    expect(everythingLogged()).not.toContain('private-arg');
  });

  it('answers a tool that finishes in time normally and leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const res = await send(callTool('echo', { a: 1 }));
    expect(json(res).result.structuredContent).toEqual({ echoed: { a: 1 } });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('methods that open a stream', () => {
  // The 2026-07-28 shape is the one the SDK would serve as a never-ending event stream.
  it.each(['subscriptions/listen', 'resources/subscribe', 'resources/unsubscribe'])('refuses a modern %s promptly with JSON, not a stream', async (method) => {
    const version = '2026-07-28';
    const meta = { [PROTOCOL_VERSION_META_KEY]: version, [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' }, [CLIENT_CAPABILITIES_META_KEY]: {} };
    const { token } = await createToken(store, { userId: 'user-a', name: 'agent', scope: 'read', expiryDays: 90 }, Math.floor(Date.now() / 1000));
    const event = makeEvent(rpc(method, { uri: 'x://y', notifications: { toolsListChanged: true }, _meta: meta }), token);
    event.headers['mcp-protocol-version'] = version;
    event.headers['mcp-method'] = method;
    const reply = handleMcpRequest(event, [fakeTool('echo')], { store, now: new Date(), tokenFailures: createFailureLimiter() });
    const timedOut = new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 2000).unref());
    const res = await Promise.race([reply, timedOut]);
    expect(res).not.toBe('timed out');
    const response = res as ApiResponse;
    expect(response.headers?.['Content-Type']).toMatch(/^application\/json/);
    expect(json(response)).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found.' } });
  });

  it.each(['subscriptions/listen', 'resources/subscribe'])('refuses %s promptly with JSON', async (method) => {
    const timedOut = new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 2000));
    const res = await Promise.race([send(rpc(method, { uri: 'x://y', notifications: { toolsListChanged: true } })), timedOut]);
    expect(res).not.toBe('timed out');
    const reply = res as ApiResponse;
    expect(reply.statusCode).toBeLessThan(500);
    expect(reply.headers?.['Content-Type']).toMatch(/^application\/json/);
    expect(json(reply).error.code).toBe(-32601);
  });
});
