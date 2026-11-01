import { describe, expect, it, vi } from 'vitest';
import { createMcpEndpoint, scrubbed } from '../sdkServer';
import { READ_ONLY } from '../tools/shared';
import type { McpContext, McpTool, ToolOutcome } from '../types';

function tool(name: string, access: McpTool['access'], seen: McpContext[] = []): McpTool {
  return {
    name,
    title: name,
    description: name,
    access,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    async run(_args, context): Promise<ToolOutcome> {
      seen.push(context);
      return { ok: true, data: { name } };
    },
  };
}

function post(body: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
}

const authInfo = (scope: string) => ({ token: '', clientId: 'token-id', scopes: [scope], extra: { userId: 'user-a' } });

describe('createMcpEndpoint', () => {
  it('registers only the tools the scope in authInfo allows', async () => {
    const endpoint = createMcpEndpoint([tool('reader', 'read'), tool('writer', 'budget')]);
    const res = await endpoint(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { authInfo: authInfo('read') });
    const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toEqual(['reader']);
  });

  it('registers no tools for a scope it does not know', async () => {
    const endpoint = createMcpEndpoint([tool('reader', 'read')]);
    const res = await endpoint(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { authInfo: authInfo('admin') });
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toEqual([]);
  });

  it('runs a tool with the user id and scope from authInfo', async () => {
    const seen: McpContext[] = [];
    const endpoint = createMcpEndpoint([tool('reader', 'read', seen)]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    try {
      await endpoint(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reader', arguments: {} } }), {
        authInfo: authInfo('write'),
      });
    } finally {
      vi.useRealTimers();
    }
    expect(seen).toEqual([{ userId: 'user-a', scope: 'write', now: new Date('2026-10-20T12:00:00.000Z') }]);
  });
});

describe('scrubbed', () => {
  it('cancels a streamed reply without reading it and answers one generic JSON error', async () => {
    const cancel = vi.fn();
    const neverEnds = new ReadableStream({ cancel });
    const streamed = new Response(neverEnds, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

    const res = await scrubbed(streamed);
    expect(cancel).toHaveBeenCalled();
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error.' } });
  });
});
