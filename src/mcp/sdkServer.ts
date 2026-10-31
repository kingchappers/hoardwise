import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { AuthInfo, CallToolResult, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { TokenScope } from '../auth/tokens';
import { MCP_MAX_BODY_BYTES, MCP_MAX_RESULT_CHARS, toolAllowed } from './types';
import type { McpContext, McpTool } from './types';

export type McpEndpoint = (request: Request, options: { authInfo: AuthInfo }) => Promise<Response>;

const SERVER_INFO = { name: 'hoardwise', version: '1.0.0' };
const FAILED = 'That request failed. Please try again.';
const TOO_LARGE = 'That result is too large to return. Ask for a narrower request, such as a shorter date range.';

// SDK error messages can echo the request (a tool name, a parse failure), so only the code survives, worded here.
const ERROR_MESSAGES: Record<number, string> = {
  [-32700]: 'Invalid JSON.',
  [-32600]: 'Invalid request.',
  [-32601]: 'Method not found.',
  [-32602]: 'Invalid params.',
  [-32603]: 'Internal error.',
  [-32020]: 'The MCP headers do not match the request body.',
  [-32021]: 'A required client capability is missing.',
  [-32022]: 'Unsupported protocol version.',
};
// The transport answers these HTTP refusals with the generic server code -32000.
const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad request.',
  406: 'Accept must include application/json and text/event-stream.',
  413: 'Request body is too large.',
  415: 'Content-Type must be application/json.',
};
const UNSUPPORTED_VERSION = -32022;
// Methods that open a long-lived stream. Every call here gets one JSON reply, so they are refused before the SDK.
const STREAM_METHODS = new Set(['subscriptions/listen', 'resources/subscribe', 'resources/unsubscribe']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScope(value: unknown): value is TokenScope {
  return value === 'read' || value === 'write';
}

function jsonReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function rpcError(code: number, message: string, id: unknown = null): Response {
  const safeId = typeof id === 'string' || typeof id === 'number' ? id : null;
  return jsonReply(200, { jsonrpc: '2.0', id: safeId, error: { code, message } });
}

// Advertises the tool's JSON Schema as written and only checks that arguments are an object; each tool validates
// its own fields, so its messages are unchanged and the SDK never words a refusal from the input.
function argumentsSchema(schema: Record<string, unknown>): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'hoardwise',
      jsonSchema: { input: () => schema, output: () => schema },
      validate: (value) => (isPlainObject(value) ? { value } : { issues: [{ message: 'Arguments must be an object.' }] }),
    },
  };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Never throws: serialising is inside the try too, so a result JSON cannot hold is a tool error.
async function runTool(tool: McpTool, args: Record<string, unknown>, context: McpContext): Promise<CallToolResult> {
  try {
    const outcome = await tool.run(args, context);
    if (!outcome.ok) return toolError(outcome.message);

    const text: string | undefined = JSON.stringify(outcome.data);
    if (text === undefined) return toolError(FAILED);
    if (text.length > MCP_MAX_RESULT_CHARS) return toolError(TOO_LARGE);
    return { content: [{ type: 'text', text }], structuredContent: outcome.data };
  } catch (error) {
    // Name only: messages can carry the person's data.
    console.error('mcp tool failed', { tool: tool.name, error: error instanceof Error ? error.name : 'unknown' });
    return toolError(FAILED);
  }
}

// A tool the connection may not use is never registered, so listing hides it and calling it is an error.
function buildServer(tools: McpTool[], authInfo: AuthInfo | undefined): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  const scope = authInfo?.scopes[0];
  const userId = authInfo?.extra?.userId;
  if (!isScope(scope) || typeof userId !== 'string') return server;

  for (const tool of tools.filter((t) => toolAllowed(scope, t.access))) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: argumentsSchema(tool.inputSchema), annotations: tool.annotations },
      (args: Record<string, unknown>) => runTool(tool, args, { userId, scope, now: new Date() }),
    );
  }
  return server;
}

// 2025-era clients get a stateless transport that answers in JSON; createMcpHandler's own legacy path would stream.
async function serveLegacy(tools: McpTool[], request: Request, parsedBody: unknown, authInfo: AuthInfo): Promise<Response> {
  const server = buildServer(tools, authInfo);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody, authInfo });
  } finally {
    await server.close();
  }
}

function errorMessage(code: number, status: number): string {
  return ERROR_MESSAGES[code] ?? STATUS_MESSAGES[status] ?? 'Request failed.';
}

// The supported versions are the server's own list, so they are kept for the client to retry with; nothing else is.
function errorData(code: number, data: unknown): { data?: { supported: string[] } } {
  if (code !== UNSUPPORTED_VERSION || !isPlainObject(data) || !Array.isArray(data.supported)) return {};
  return { data: { supported: data.supported.filter((v): v is string => typeof v === 'string') } };
}

// Keeps only the code of a JSON-RPC error, so no SDK wording, echoed input or `data` reaches the client.
export async function scrubbed(response: Response): Promise<Response> {
  // A stream is never read: it may stay open for good, so it is cancelled and answered with a generic error.
  if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    await response.body?.cancel().catch(() => undefined);
    return rpcError(-32603, ERROR_MESSAGES[-32603]);
  }
  const text = await response.text();
  if (text === '') return new Response(null, { status: response.status });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(-32603, ERROR_MESSAGES[-32603]);
  }
  if (!isPlainObject(body) || !isPlainObject(body.error)) return jsonReply(response.status, body);

  const code = typeof body.error.code === 'number' ? body.error.code : -32603;
  const id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
  const error = { code, message: errorMessage(code, response.status), ...errorData(code, body.error.data) };
  return jsonReply(response.status, { jsonrpc: '2.0', id, error });
}

function parseBody(text: string): { parsed: unknown } | undefined {
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    // Left to the SDK, which answers a parse error.
    return undefined;
  }
}

export function createMcpEndpoint(tools: McpTool[]): McpEndpoint {
  // Built once: the handler warns on every construction that JSON mode drops mid-call notifications.
  const modern = createMcpHandler((ctx) => buildServer(tools, ctx.authInfo), {
    legacy: 'reject',
    responseMode: 'json',
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
  });

  return async (request, { authInfo }) => {
    // The caller has already capped the body at MCP_MAX_BODY_BYTES, so reading it whole is bounded.
    const body = parseBody(await request.clone().text());
    if (Array.isArray(body?.parsed)) return rpcError(-32600, 'Batch requests are not supported.');
    if (isPlainObject(body?.parsed) && typeof body.parsed.method === 'string' && STREAM_METHODS.has(body.parsed.method)) {
      return rpcError(-32601, ERROR_MESSAGES[-32601], body.parsed.id);
    }

    const parsedBody = body?.parsed;
    const legacy = await isLegacyRequest(request, parsedBody, { maxRequestBodySize: MCP_MAX_BODY_BYTES });
    const response = legacy
      ? await serveLegacy(tools, request, parsedBody, authInfo)
      : await modern.fetch(request, { parsedBody, authInfo });
    return scrubbed(response);
  };
}
