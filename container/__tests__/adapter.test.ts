import { request as httpRequest, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createRequestListener, type AdapterDeps, type HandlerResult } from '../adapter';

let server: Server;
let base: string;
let seen: APIGatewayProxyEventV2[];
let apiResult: HandlerResult;
let staticResult: HandlerResult;
let healthy: boolean;

function start(overrides: Partial<AdapterDeps> = {}): Promise<void> {
  const listener = createRequestListener({
    apiHandler: async event => { seen.push(event); return apiResult; },
    staticHandler: async () => staticResult,
    configBody: '{"auth":"local"}',
    trustProxy: false,
    isHealthy: async () => healthy,
    log: () => undefined,
    ...overrides,
  });
  server = createServer(listener);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}

beforeEach(() => {
  seen = [];
  apiResult = { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":1}' };
  staticResult = { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: '<html></html>' };
  healthy = true;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

describe('routing', () => {
  it('answers /healthz and flips to 503 when unhealthy', async () => {
    await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    healthy = false;
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
  });

  it('serves /config.json itself, ahead of the static handler', async () => {
    const staticHandler = vi.fn(async () => staticResult);
    await start({ staticHandler });
    const response = await fetch(`${base}/config.json`);
    expect(await response.json()).toEqual({ auth: 'local' });
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(staticHandler).not.toHaveBeenCalled();
  });

  it('sends everything else to the static handler and refuses other methods there', async () => {
    await start();
    expect(await (await fetch(`${base}/anything`)).text()).toBe('<html></html>');
    const post = await fetch(`${base}/anything`, { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('rejects a request target that is not origin-form', async () => {
    await start();
    const status = await new Promise<number>(resolve => {
      const req = httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, method: 'GET', path: 'http://evil.test/x' }, res => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(400);
  });
});

describe('path normalisation', () => {
  const rawGet = (path: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, method: 'GET', path }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

  for (const path of ['//config.json', '/%63onfig.json', '/./config.json', '/a/../config.json', '/config.json?x=1']) {
    it(`serves the server's own config for ${path}`, async () => {
      const staticHandler = vi.fn(async () => staticResult);
      await start({ staticHandler });
      const response = await rawGet(path);
      expect(JSON.parse(response.body)).toEqual({ auth: 'local' });
      expect(staticHandler).not.toHaveBeenCalled();
    });
  }

  it('answers 400 to a malformed escape and to an encoded NUL', async () => {
    await start();
    expect((await rawGet('/%zz')).status).toBe(400);
    expect((await rawGet('/a%00b')).status).toBe(400);
  });

  it('treats //healthz and /%68ealthz as /healthz', async () => {
    await start();
    healthy = false;
    expect((await rawGet('//healthz')).status).toBe(503);
    expect((await rawGet('/%68ealthz')).status).toBe(503);
  });

  it('keeps the raw path in rawPath for the API', async () => {
    await start();
    await rawGet('/api/a%2Fb');
    expect(seen[0].rawPath).toBe('/api/a%2Fb');
  });
});

describe('the API event', () => {
  it('lower-cases headers, splits cookies, keeps the query and never puts the path in routeKey', async () => {
    await start();
    await fetch(`${base}/api/transactions/2026-10/abc-123?x=1&y=two%20words`, {
      method: 'DELETE', headers: { 'X-Custom': 'v', Cookie: 'a=1; b=2' },
    });
    const event = seen[0];
    expect(event.rawPath).toBe('/api/transactions/2026-10/abc-123');
    expect(event.rawQueryString).toBe('x=1&y=two%20words');
    expect(event.queryStringParameters).toEqual({ x: '1', y: 'two words' });
    expect(event.headers['x-custom']).toBe('v');
    expect(event.cookies).toEqual(['a=1', 'b=2']);
    expect(event.requestContext.http.method).toBe('DELETE');
    expect(event.requestContext.routeKey).toBe('DELETE /api/{proxy+}');
    expect(JSON.stringify(event.requestContext)).not.toContain('abc-123');
  });

  it('passes the body of a POST and none for a GET', async () => {
    await start();
    await fetch(`${base}/api/x`, { method: 'POST', body: '{"a":1}' });
    await fetch(`${base}/api/x`);
    expect(seen[0].body).toBe('{"a":1}');
    expect(seen[1].body).toBeUndefined();
  });

  it('writes status, headers, a body, every cookie as its own Set-Cookie, and decodes base64', async () => {
    apiResult = { statusCode: 201, headers: { 'X-One': '1' }, body: 'hello', cookies: ['a=1; HttpOnly', 'b=2; HttpOnly'] };
    await start();
    const response = await fetch(`${base}/api/x`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-one')).toBe('1');
    expect(response.headers.getSetCookie()).toEqual(['a=1; HttpOnly', 'b=2; HttpOnly']);
    expect(await response.text()).toBe('hello');

    staticResult = { statusCode: 200, headers: { 'Content-Type': 'image/png' }, body: Buffer.from([1, 2, 3, 250]).toString('base64'), isBase64Encoded: true };
    const image = Buffer.from(await (await fetch(`${base}/logo.png`)).arrayBuffer());
    expect([...image]).toEqual([1, 2, 3, 250]);
  });

  it('answers a generic 500 without detail when the handler throws, and keeps serving', async () => {
    const logs: string[] = [];
    await start({ apiHandler: async () => { throw new Error('secret detail'); }, log: message => logs.push(message) });
    const response = await fetch(`${base}/api/x`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret detail');
    expect(logs.join(' ')).not.toContain('secret detail');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe('forwarding headers', () => {
  const send = (headers: Record<string, string>) => fetch(`${base}/api/x`, { method: 'POST', body: '{}', headers });

  it('strips them and uses the socket address when the proxy is not trusted', async () => {
    await start({ trustProxy: false });
    await send({ 'x-forwarded-for': '6.6.6.6', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https', forwarded: 'for=6.6.6.6' });
    const event = seen[0];
    for (const name of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']) expect(event.headers[name]).toBeUndefined();
    expect(event.requestContext.http.sourceIp).toMatch(/127\.0\.0\.1$/);
  });

  it('keeps them and takes the first forwarded address when the proxy is trusted', async () => {
    await start({ trustProxy: true });
    await send({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'x-forwarded-host': 'budget.example.com' });
    expect(seen[0].requestContext.http.sourceIp).toBe('203.0.113.7');
    expect(seen[0].headers['x-forwarded-host']).toBe('budget.example.com');
  });
});

describe('bodies that are not read', () => {
  const sendWithBody = (path: string, method: string): Promise<{ connection: string | undefined }> => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, method, path, headers: { 'Content-Length': '5' } }, res => {
      res.resume();
      resolve({ connection: res.headers.connection });
    });
    req.on('error', reject);
    req.end('hello');
  });

  it('closes the connection after a GET that carries a body', async () => {
    await start();
    expect((await sendWithBody('/anything', 'GET')).connection).toBe('close');
  });

  it('closes the connection after a 405 that carries a body', async () => {
    await start();
    expect((await sendWithBody('/anything', 'POST')).connection).toBe('close');
  });
});

describe('the body limit', () => {
  type Outcome = { outcome: '413' | 'reset' | 'other'; status?: number };

  function upload(options: { chunked: boolean; bytes: number }): Promise<Outcome> {
    return new Promise(resolve => {
      const headers: Record<string, string | number> = options.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': options.bytes };
      const req = httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, method: 'POST', path: '/api/x', headers }, res => {
        res.resume();
        resolve({ outcome: res.statusCode === 413 ? '413' : 'other', status: res.statusCode });
      });
      req.on('error', () => resolve({ outcome: 'reset' }));
      const piece = Buffer.alloc(64 * 1024, 120);
      let sent = 0;
      const pump = (): void => {
        while (sent < options.bytes) {
          const slice = piece.subarray(0, Math.min(piece.length, options.bytes - sent));
          sent += slice.length;
          if (!req.write(slice)) {
            req.once('drain', pump);
            return;
          }
        }
        req.end();
      };
      pump();
    });
  }

  it('answers 413 to a small overshoot of a Content-Length', async () => {
    await start({ maxBodyBytes: 1024 });
    const response = await fetch(`${base}/api/x`, { method: 'POST', body: 'x'.repeat(2048) });
    expect(response.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('answers 413 to a small chunked overshoot, read from a real response', async () => {
    await start({ maxBodyBytes: 1024 });
    const result = await upload({ chunked: true, bytes: 2048 });
    expect(result).toEqual({ outcome: '413', status: 413 });
    expect(seen).toHaveLength(0);
  });

  it('answers 413 to an upload that finishes inside the grace window', async () => {
    await start({ maxBodyBytes: 1024 * 1024 });
    const result = await upload({ chunked: false, bytes: 1024 * 1024 + 4096 });
    expect(result.outcome).toBe('413');
    expect(seen).toHaveLength(0);
  });

  for (const chunked of [false, true]) {
    it(`terminates a large ${chunked ? 'chunked' : 'Content-Length'} upload, never calls the handler and keeps serving`, async () => {
      await start({ maxBodyBytes: 1024 * 1024 });
      const result = await upload({ chunked, bytes: 8 * 1024 * 1024 });
      expect(result.outcome === '413' || result.outcome === 'reset').toBe(true);
      expect(seen).toHaveLength(0);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    });
  }

  it('accepts a body at exactly the limit', async () => {
    await start({ maxBodyBytes: 1024 });
    const response = await fetch(`${base}/api/x`, { method: 'POST', body: 'x'.repeat(1024) });
    expect(response.status).toBe(200);
    expect(seen[0].body).toHaveLength(1024);
  });
});

describe('the /mcp route', () => {
  it('sends POST /mcp to the API handler as it does /api/', async () => {
    await start();
    const response = await fetch(`${base}/mcp`, { method: 'POST', body: '{"jsonrpc":"2.0"}' });
    expect(response.status).toBe(200);
    expect(seen[0].rawPath).toBe('/mcp');
    expect(seen[0].body).toBe('{"jsonrpc":"2.0"}');
  });

  it('sends GET /mcp to the API handler with no body', async () => {
    await start();
    await fetch(`${base}/mcp`);
    expect(seen[0].rawPath).toBe('/mcp');
    expect(seen[0].body).toBeUndefined();
  });

  it('answers 413 to a body over the cap without calling the handler', async () => {
    await start({ maxBodyBytes: 1024 });
    const response = await fetch(`${base}/mcp`, { method: 'POST', body: 'x'.repeat(2048) });
    expect(response.status).toBe(413);
    expect(seen).toHaveLength(0);
  });
});

describe('client aborts and logging', () => {
  it('stays quiet when a client aborts mid-body and keeps serving', async () => {
    const logs: string[] = [];
    await start({ log: message => logs.push(message) });
    await new Promise<void>(resolve => {
      const req = httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, method: 'POST', path: '/api/x', headers: { 'Content-Length': '1000' } });
      req.on('error', () => undefined);
      req.write('partial', () => {
        req.destroy();
        setTimeout(resolve, 100);
      });
    });
    expect(logs.filter(message => message.includes('Request failed'))).toEqual([]);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('survives a logger that throws', async () => {
    await start({ apiHandler: async () => { throw new Error('x'); }, log: () => { throw new Error('log down'); } });
    expect((await fetch(`${base}/api/x`)).status).toBe(500);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
