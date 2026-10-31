import { describe, expect, it } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';

// Proves the SDK loads and can answer both protocol eras with one JSON reply before the protocol layer moves onto it.
const newServer = (): McpServer => new McpServer({ name: 'hoardwise', version: '0.0.0' });

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://example.invalid/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

async function expectJsonServerName(response: Response, read: (result: Record<string, any>) => unknown): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  const body = (await response.json()) as { result: Record<string, any> };
  expect(read(body.result)).toBe('hoardwise');
}

describe('@modelcontextprotocol/server', () => {
  it('answers a 2026-07-28 server/discover through createMcpHandler with a single JSON reply', async () => {
    const mcp = createMcpHandler(newServer, { responseMode: 'json' });
    const version = '2026-07-28';
    const meta = {
      [PROTOCOL_VERSION_META_KEY]: version,
      [CLIENT_INFO_META_KEY]: { name: 'test', version: '0.0.0' },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    };
    const request = post(
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } },
      { 'mcp-protocol-version': version, 'mcp-method': 'server/discover' },
    );

    await expectJsonServerName(await mcp.fetch(request), result => result._meta?.['io.modelcontextprotocol/serverInfo']?.name);
  });

  it('answers a 2025-06-18 initialize through a JSON-response stateless transport with a single JSON reply', async () => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await newServer().connect(transport);
    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
    });

    await expectJsonServerName(await transport.handleRequest(request), result => result.serverInfo?.name);
  });
});
