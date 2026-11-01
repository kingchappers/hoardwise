import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { handler as apiLambda } from '../api-handler';
import { getAuth, setAuth } from '../src/auth';
import { createLocalProvider } from '../src/auth/local';
import { getStore, initStore, setStore } from '../src/store';
import { createBackup, newestBackupAgeSeconds, pruneBackups } from '../src/store/backup';
import { SqliteStore } from '../src/store/sqlite';
import { createStaticHandler } from '../src/static/handler';
import { buildCaddyfile } from './caddy';
import { createRequestListener, type HandlerResult } from './adapter';
import { parseConfig, type ContainerConfig } from './config';
import { startMaintenance } from './maintenance';
import { consumeResetMarker, createCodeHooks, removeCodeFile } from './recovery';

export interface RunningServer {
  config: ContainerConfig;
  port: number;
  host: string;
  close(): Promise<void>;
}

export interface StartOptions {
  clientDir?: string;
  log?: (message: string) => void;
  // Called when Caddy dies or cannot start while the server is running.
  onFatal?: (reason: string) => void;
  // Test seam: replaces child_process.spawn for Caddy.
  spawnCaddy?: typeof spawn;
  // Test seam: replaces the real API Lambda handler.
  apiHandler?: (event: APIGatewayProxyEventV2) => Promise<HandlerResult>;
  // How long close() lets connections finish before cutting them (default 10 s).
  shutdownGraceMs?: number;
  // How long close() then waits for handlers still running before releasing the store (default 2 s).
  handlerGraceMs?: number;
}

const SHUTDOWN_GRACE_MS = 10_000;
const HANDLER_GRACE_MS = 2_000;
// After SIGKILL, how long to wait for Caddy's exit event before carrying on.
const KILL_WAIT_MS = 1_000;

const SHUTTING_DOWN: HandlerResult = {
  statusCode: 503,
  headers: { 'Content-Type': 'application/json', 'Retry-After': '1', Connection: 'close' },
  body: '{"error":"Shutting down"}',
};

const isRegistered = (get: () => unknown): boolean => {
  try {
    get();
    return true;
  } catch {
    return false;
  }
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'Error');

// Turns a listen failure into a message an operator can act on.
export function describeListenError(error: NodeJS.ErrnoException, port: number): Error {
  if (error.code === 'EADDRINUSE') return new Error(`Port ${port} is already in use`);
  if (error.code === 'EACCES') {
    return new Error(`Cannot listen on port ${port}: permission denied (use a port above 1023, or run the container with the right capability)`);
  }
  return error;
}

export async function startServer(env: NodeJS.ProcessEnv, options: StartOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((message: string) => console.log(message));
  const config = parseConfig(env);
  if (isRegistered(getStore) || isRegistered(getAuth)) {
    throw new Error('Another server instance is still running in this process');
  }
  for (const warning of config.warnings) console.warn(warning);
  const warn = (message: string): void => console.warn(message);

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  // The handlers read the registries on their first call, so initialising them here with an explicit environment is enough.
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...env,
    AUTH_MODE: 'local',
    STORE: 'sqlite',
    SQLITE_PATH: config.sqlitePath,
    COOKIE_SECURE: String(config.secureCookie),
    APP_ORIGIN: config.appOrigin ?? '',
  };
  // The API handler reads the public origin from the process environment on its first request.
  if (config.appOrigin) process.env.APP_ORIGIN = config.appOrigin;
  const opened = await initStore(runtimeEnv);

  let maintenance: { stop(): void } | undefined;
  const releaseInternals = (): void => {
    maintenance?.stop();
    removeCodeFile(config.dataDir, warn);
    (opened as { close?: () => void }).close?.();
    setStore(undefined);
    setAuth(undefined);
  };

  try {
    if (!(opened instanceof SqliteStore)) throw new Error('The container requires the SQLite store');
    const store: SqliteStore = opened;
    // A code file never outlives the process that made it; a fresh code is written below if one is needed.
    removeCodeFile(config.dataDir, warn);
    const reset = consumeResetMarker(config.dataDir, warn);
    // Logs the one-time setup (or recovery) code and saves a copy in the data folder.
    setAuth(await createLocalProvider(runtimeEnv, {
      recovery: reset === 'consumed',
      hooks: createCodeHooks(config.dataDir, { print: text => console.log(text), warn }),
    }));

    maintenance = startMaintenance(
      {
        purgeExpired: () => store.purgeExpired(),
        backup: now => {
          createBackup(store, config.backupDir, now);
          pruneBackups(config.backupDir, config.backupKeep);
        },
        newestBackupAgeSeconds: now => newestBackupAgeSeconds(config.backupDir, now),
        log,
      },
      { backupHour: config.backupHour, backupKeep: config.backupKeep },
    );

    const staticHandler = createStaticHandler(options.clientDir ?? env.CLIENT_DIR ?? path.resolve(process.cwd(), 'build/client'));
    const realApi = async (event: APIGatewayProxyEventV2): Promise<HandlerResult> =>
      (await apiLambda(event, {} as Context, () => undefined)) as HandlerResult;

    // Handlers still running at shutdown are waited for (briefly) before the store is released, and
    // nothing new starts once shutdown has begun, so no handler can touch the cleared registries.
    let shuttingDown = false;
    const inflight = new Set<Promise<unknown>>();
    const tracked = <E>(handle: (event: E) => Promise<HandlerResult>) => (event: E): Promise<HandlerResult> => {
      if (shuttingDown) return Promise.resolve(SHUTTING_DOWN);
      const promise: Promise<HandlerResult> = handle(event).finally(() => { inflight.delete(promise); });
      inflight.add(promise);
      return promise;
    };

    const server = createServer(createRequestListener({
      apiHandler: tracked(options.apiHandler ?? realApi),
      staticHandler: tracked((event: { rawPath: string }) => staticHandler(event) as Promise<HandlerResult>),
      configBody: JSON.stringify({ auth: 'local' }),
      trustProxy: config.trustProxy,
      isHealthy: async () => {
        await store.get({ PK: 'HEALTH', SK: 'PING' });
        return true;
      },
      log,
    }));
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    // The request timeout is only checked this often, so it is enforced within ~5 s of its deadline.
    (server as { connectionsCheckingInterval?: number }).connectionsCheckingInterval = 5_000;
    server.on('error', (error: Error) => log(`Server error: ${errorName(error)}`));

    // With Caddy in front, only the loopback interface is exposed.
    const host = config.tlsDomain ? '127.0.0.1' : '0.0.0.0';
    await new Promise<void>((resolve, reject) => {
      const onListenError = (error: NodeJS.ErrnoException): void => reject(describeListenError(error, config.port));
      server.once('error', onListenError);
      server.listen(config.port, host, () => {
        server.off('error', onListenError);
        resolve();
      });
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;

    // close() waits up to shutdownGraceMs for connections, then at most handlerGraceMs more for handlers
    // still running (10 s + 2 s by default) before it releases the store. It never rejects.
    const shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    const handlerGraceMs = options.handlerGraceMs ?? HANDLER_GRACE_MS;
    let closing: Promise<void> | undefined;

    let caddy: ChildProcess | undefined;
    let caddyExited = true;
    let caddyDir: string | undefined;
    const startCaddy = (tlsDomain: string): void => {
      caddyDir = mkdtempSync(path.join(os.tmpdir(), 'hoardwise-caddy-'));
      const caddyfile = path.join(caddyDir, 'Caddyfile');
      writeFileSync(
        caddyfile,
        buildCaddyfile({ tlsDomain, tlsEmail: config.tlsEmail, port, dataDir: config.dataDir }),
        { mode: 0o600 },
      );
      const child = (options.spawnCaddy ?? spawn)('caddy', ['run', '--config', caddyfile, '--adapter', 'caddyfile'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          // Caddy keeps its own state under the data volume, and its autosave config in a writable temporary directory.
          XDG_CONFIG_HOME: path.join(os.tmpdir(), 'caddy-config'),
          XDG_DATA_HOME: path.join(config.dataDir, 'caddy-data'),
        },
      });
      caddy = child;
      caddyExited = false;
      child.once('exit', (code, signal) => {
        caddyExited = true;
        if (!shuttingDown) options.onFatal?.(`Caddy exited (${signal ?? code})`);
      });
      child.on('error', error => {
        // A process that never started will never emit 'exit'.
        caddyExited = true;
        if (!shuttingDown) options.onFatal?.(`Could not start Caddy: ${error.message}`);
      });
    };

    // SIGTERM, then SIGKILL after the same grace period as the connections. Never rejects.
    const stopCaddy = async (): Promise<void> => {
      const child = caddy;
      if (!child || caddyExited) return;
      await new Promise<void>(resolve => {
        let timer: NodeJS.Timeout | undefined;
        const done = (): void => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        child.once('exit', done);
        child.once('error', done);
        timer = setTimeout(() => {
          timer = setTimeout(done, KILL_WAIT_MS);
          child.kill('SIGKILL');
        }, shutdownGraceMs);
        child.kill('SIGTERM');
      });
    };
    const discardCaddyFiles = (): void => {
      if (caddyDir) rmSync(caddyDir, { recursive: true, force: true });
    };

    if (config.tlsDomain) {
      try {
        startCaddy(config.tlsDomain);
      } catch (error) {
        shuttingDown = true;
        caddy?.kill('SIGKILL');
        discardCaddyFiles();
        // The outer catch releases the store and registries but does not know about the listening socket.
        server.close();
        server.closeAllConnections();
        throw error;
      }
    }

    const close = (): Promise<void> => {
      closing ??= (async () => {
        shuttingDown = true;
        maintenance?.stop();
        try {
          // Caddy stops taking public traffic while the connections drain.
          const caddyStopped = stopCaddy();
          await new Promise<void>(resolve => {
            const force = setTimeout(() => server.closeAllConnections(), shutdownGraceMs);
            // Connections that go idle after this point (or never were) would otherwise sit out their keep-alive.
            const sweep = setInterval(() => server.closeIdleConnections(), 100);
            sweep.unref();
            server.close(() => {
              clearTimeout(force);
              clearInterval(sweep);
              resolve();
            });
            server.closeIdleConnections();
          });
          let giveUp: NodeJS.Timeout | undefined;
          const timeout = new Promise<void>(resolve => {
            giveUp = setTimeout(resolve, handlerGraceMs);
            giveUp.unref();
          });
          await Promise.race([Promise.allSettled([...inflight]), timeout]);
          clearTimeout(giveUp);
          await caddyStopped;
        } catch (error) {
          log(`Shutdown error: ${errorName(error)}`);
        } finally {
          discardCaddyFiles();
          removeCodeFile(config.dataDir, warn);
          try {
            store.close();
          } catch (error) {
            log(`Closing the database failed: ${errorName(error)}`);
          }
          setStore(undefined);
          setAuth(undefined);
        }
      })();
      return closing;
    };

    return { config, port, host, close };
  } catch (error) {
    releaseInternals();
    throw error;
  }
}
