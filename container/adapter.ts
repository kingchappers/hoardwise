import type { IncomingMessage, ServerResponse } from 'node:http';
import { posix } from 'node:path';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export const MAX_BODY_BYTES = 1024 * 1024;

export interface HandlerResult {
  statusCode?: number;
  headers?: Record<string, string | number | boolean>;
  body?: string;
  cookies?: string[];
  isBase64Encoded?: boolean;
}

export interface AdapterDeps {
  apiHandler(event: APIGatewayProxyEventV2): Promise<HandlerResult>;
  staticHandler(event: { rawPath: string }): Promise<HandlerResult>;
  configBody: string;
  trustProxy: boolean;
  isHealthy(): Promise<boolean>;
  maxBodyBytes?: number;
  log?(message: string): void;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}

const FORWARDED = new Set(['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded']);

// No timer here: slow uploads are bounded by server.requestTimeout, which the entry point (Task 7) sets.
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function lowerCaseHeaders(raw: IncomingMessage['headers'], trustProxy: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (value === undefined) continue;
    if (!trustProxy && FORWARDED.has(key)) continue;
    headers[key] = Array.isArray(value) ? value.join(',') : value;
  }
  return headers;
}

export function buildEvent(req: IncomingMessage, pathname: string, query: string, body: string, trustProxy: boolean): APIGatewayProxyEventV2 {
  const headers = lowerCaseHeaders(req.headers, trustProxy);
  const method = req.method ?? 'GET';
  const forwardedFor = trustProxy ? headers['x-forwarded-for']?.split(',')[0].trim() : undefined;
  const sourceIp = forwardedFor || req.socket.remoteAddress || '';
  // Handlers log routeKey, and path segments can carry resource IDs: never put the raw path here.
  const routeKey = `${method} /api/{proxy+}`;
  const parameters = Object.fromEntries(new URLSearchParams(query));

  return {
    version: '2.0',
    routeKey,
    rawPath: pathname,
    rawQueryString: query,
    cookies: headers.cookie ? headers.cookie.split(';').map(part => part.trim()).filter(Boolean) : [],
    headers,
    queryStringParameters: Object.keys(parameters).length > 0 ? parameters : undefined,
    requestContext: {
      accountId: 'container',
      apiId: 'container',
      domainName: headers.host ?? '',
      domainPrefix: '',
      requestId: '',
      routeKey,
      stage: '$default',
      time: '',
      timeEpoch: Date.now(),
      http: { method, path: '/api/{proxy+}', protocol: 'HTTP/1.1', sourceIp, userAgent: headers['user-agent'] ?? '' },
    },
    body: body === '' ? undefined : body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

export function writeResult(res: ServerResponse, result: HandlerResult, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string | string[]> = { ...extraHeaders };
  for (const [name, value] of Object.entries(result.headers ?? {})) headers[name] = String(value);
  if (result.cookies && result.cookies.length > 0) headers['Set-Cookie'] = result.cookies;
  const body = result.body === undefined ? '' : result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body;
  res.writeHead(result.statusCode ?? 200, headers);
  res.end(body);
}

const LINGER_MS = 2000;

function hasBody(req: IncomingMessage): boolean {
  const length = Number(req.headers['content-length']);
  return (Number.isFinite(length) && length > 0) || req.headers['transfer-encoding'] !== undefined;
}

// A path for routing decisions only: decoded and normalised so "//config.json", "/%63onfig.json" and
// "/a/../config.json" cannot slip past the exact-match checks. Null means malformed.
function routingPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  return posix.normalize(decoded).replace(/^\/+/, '/');
}

// Best effort: answer 413 without Connection: close (Node would reset the socket the moment the response
// ends, before an in-flight upload is read), then drain and discard the rest of the upload for up to LINGER_MS so a client that
// is still sending can read the response. A client that keeps uploading past that (or one that is mid-upload)
// may see a connection reset instead of the 413. That is acceptable: the handler is never reached and nothing
// is buffered.
function rejectTooLarge(req: IncomingMessage, res: ServerResponse): void {
  json(res, 413, { error: 'Request body too large' });
  const timer = setTimeout(() => req.destroy(), LINGER_MS);
  timer.unref();
  const clear = (): void => clearTimeout(timer);
  req.once('end', clear);
  req.once('close', clear);
  req.resume();
}

function isClientAbort(req: IncomingMessage, res: ServerResponse, error: unknown): boolean {
  if (res.destroyed || res.writableEnded || req.destroyed) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

function json(res: ServerResponse, status: number, payload: object, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(payload));
}

export function createRequestListener(deps: AdapterDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const limit = deps.maxBodyBytes ?? MAX_BODY_BYTES;
  const log = deps.log ?? ((message: string) => console.error(message));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? '/';
    // A body we will not read must not keep the connection alive past the response.
    const unread: Record<string, string> = hasBody(req) ? { Connection: 'close' } : {};
    // Only origin-form targets ("/path?query"). Anything else ("http://host/x", "*") is not a request we serve.
    if (!target.startsWith('/')) {
      json(res, 400, { error: 'Bad request' }, unread);
      return;
    }
    const queryAt = target.indexOf('?');
    const pathname = queryAt === -1 ? target : target.slice(0, queryAt);
    const query = queryAt === -1 ? '' : target.slice(queryAt + 1);
    const routed = routingPath(pathname);
    if (routed === null) {
      json(res, 400, { error: 'Bad request' }, unread);
      return;
    }
    const method = req.method ?? 'GET';
    const readOnly = method === 'GET' || method === 'HEAD';
    const notAllowed = (): void => json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD', ...unread });

    if (routed === '/healthz') {
      if (!readOnly) {
        notAllowed();
        return;
      }
      const ok = await deps.isHealthy().catch(() => false);
      json(res, ok ? 200 : 503, { ok }, unread);
      return;
    }

    if (routed === '/config.json') {
      if (!readOnly) {
        notAllowed();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...unread });
      res.end(deps.configBody);
      return;
    }

    if (pathname.startsWith('/api/') || routed === '/mcp') {
      let body = '';
      if (!readOnly) {
        try {
          body = await readBody(req, limit);
        } catch (error) {
          if (!(error instanceof BodyTooLargeError)) throw error;
          rejectTooLarge(req, res);
          return;
        }
      }
      writeResult(res, await deps.apiHandler(buildEvent(req, pathname, query, body, deps.trustProxy)), readOnly ? unread : {});
      return;
    }

    if (!readOnly) {
      notAllowed();
      return;
    }
    writeResult(res, await deps.staticHandler({ rawPath: target }), unread);
  }

  return (req, res) => {
    handle(req, res).catch(error => {
      if (isClientAbort(req, res, error)) return;
      try {
        // The error name only: a message can echo request details.
        log(`Request failed: ${error instanceof Error ? error.name : 'Error'}`);
      } catch {
        // A failing logger must not take the process down.
      }
      if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
      else res.end();
    });
  };
}
