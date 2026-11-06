import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export interface ContainerConfig {
  dataDir: string;
  sqlitePath: string;
  port: number;
  tlsDomain?: string;
  tlsEmail?: string;
  // The public URL (scheme, host, port), from APP_ORIGIN or derived from TLS_DOMAIN.
  appOrigin?: string;
  secureCookie: boolean;
  trustProxy: boolean;
  backupHour: number;
  backupKeep: number;
  backupDir: string;
  warnings: string[];
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// No whitespace, braces, quotes, backslashes or backticks: this value is written into a Caddyfile.
const EMAIL = /^[^\s@{}"'\\`]+@[^\s@{}"'\\`]+$/;
// DATA_DIR is also written into a Caddyfile, so it is restricted to a safe character set.
const SAFE_PATH = /^\/[\w./-]*$/;

export function isValidHostname(value: string): boolean {
  return HOSTNAME.test(value) && !IPV4.test(value);
}

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

function wholeNumber(name: string, raw: string | undefined, fallback: number, min: number, max: number, problems: string[]): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    problems.push(`${name} must be a whole number`);
    return fallback;
  }
  const value = Number(raw);
  if (value < min || value > max) {
    problems.push(`${name} must be between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function flag(name: string, raw: string | undefined, problems: string[]): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(`${name} must be "true" or "false" when set`);
  return undefined;
}

function checkDirectory(name: string, value: string, problems: string[]): void {
  const safe = SAFE_PATH.test(value) && value !== '/' && !value.split('/').includes('..');
  if (!safe) problems.push(`${name} must be an absolute path using only letters, digits and . _ / -, with no .. segment and not /`);
}

export const SQLITE_FILE = 'hoardwise.sqlite';
// Installs created before the rename keep this file as it is: renaming a live SQLite file also means moving its -wal and
// -shm files, and a crash between the moves can lose recent writes.
export const LEGACY_SQLITE_FILE = 'budget.sqlite';

// Whether the database holds any items: true or false when it could be read, undefined when it could not. It opens the file
// read-only, so it never creates, migrates or writes to it.
export function sqliteHasItems(path: string): boolean | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'").get();
    if (!table) return false;
    return db.prepare('SELECT 1 FROM items LIMIT 1').get() !== undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export function chooseSqliteFile(
  dataDir: string,
  exists: (path: string) => boolean,
  hasItems: (path: string) => boolean | undefined = sqliteHasItems,
): { path: string; warning?: string } {
  const current = `${dataDir}/${SQLITE_FILE}`;
  const legacy = `${dataDir}/${LEGACY_SQLITE_FILE}`;
  if (!exists(current)) return { path: exists(legacy) ? legacy : current };
  if (!exists(legacy)) return { path: current };
  // An empty hoardwise.sqlite next to a populated budget.sqlite is almost always one created by mistake on an older install
  // (for example by a command run before the CLI checked the path), so the data is used rather than hidden. Anything unclear
  // keeps the rule below, and neither file is renamed or deleted.
  if (hasItems(current) === false && hasItems(legacy) === true) {
    return {
      path: legacy,
      warning: `Both ${SQLITE_FILE} and ${LEGACY_SQLITE_FILE} exist in ${dataDir}, and ${SQLITE_FILE} is empty. Using ${LEGACY_SQLITE_FILE}, which holds your data. Neither file was changed; you can delete the empty ${SQLITE_FILE} when the app is stopped.`,
    };
  }
  return {
    path: current,
    warning: `Both ${SQLITE_FILE} and ${LEGACY_SQLITE_FILE} exist in ${dataDir}. Using ${SQLITE_FILE}; the data in ${LEGACY_SQLITE_FILE} is not being read. If ${SQLITE_FILE} is an empty file created by mistake, stop the app and remove it so ${LEGACY_SQLITE_FILE} is used again.`,
  };
}

export function parseConfig(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
  hasItems: (path: string) => boolean | undefined = sqliteHasItems,
): ContainerConfig {
  const problems: string[] = [];
  const warnings: string[] = [];

  const dataDir = env.DATA_DIR || '/data';
  checkDirectory('DATA_DIR', dataDir, problems);
  const backupDir = env.BACKUP_DIR || `${dataDir}/backups`;
  if (env.BACKUP_DIR) checkDirectory('BACKUP_DIR', backupDir, problems);

  const port = wholeNumber('PORT', env.PORT, 8080, 0, 65535, problems);
  const backupHour = wholeNumber('BACKUP_HOUR', env.BACKUP_HOUR, 3, 0, 23, problems);
  const backupKeep = wholeNumber('BACKUP_KEEP', env.BACKUP_KEEP, 7, 0, 365, problems);

  const rawDomain = env.TLS_DOMAIN?.trim().toLowerCase();
  let tlsDomain: string | undefined;
  if (rawDomain) {
    if (isValidHostname(rawDomain)) tlsDomain = rawDomain;
    else problems.push('TLS_DOMAIN must be a plain hostname such as hoardwise.example.com (no scheme, port, path or wildcard)');
    if (port === 0) problems.push('PORT must be a fixed port (not 0) when TLS_DOMAIN is set');
    if (port === 80 || port === 443) problems.push('PORT must not be 80 or 443 when TLS_DOMAIN is set (Caddy uses those ports)');
  }

  const rawEmail = env.TLS_EMAIL?.trim();
  let tlsEmail: string | undefined;
  if (rawEmail) {
    if (!rawDomain) problems.push('TLS_EMAIL is set but TLS_DOMAIN is not');
    else if (isValidEmail(rawEmail)) tlsEmail = rawEmail;
    else problems.push('TLS_EMAIL must be a plain email address');
  }

  let appOrigin: string | undefined;
  const rawOrigin = env.APP_ORIGIN?.trim();
  if (rawOrigin) {
    try {
      const url = new URL(rawOrigin);
      const plain = (url.protocol === 'http:' || url.protocol === 'https:')
        && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
      if (!plain) throw new Error('not a plain origin');
      appOrigin = url.origin;
      if (tlsDomain && url.hostname !== tlsDomain) problems.push('APP_ORIGIN must use the same host as TLS_DOMAIN');
      if (tlsDomain && url.protocol !== 'https:') problems.push('APP_ORIGIN must be https when TLS_DOMAIN is set');
    } catch {
      problems.push('APP_ORIGIN must be a plain URL such as https://hoardwise.example.com (no path, query or credentials)');
    }
  } else if (tlsDomain) {
    appOrigin = `https://${tlsDomain}`;
  }

  const explicitSecure = flag('COOKIE_SECURE', env.COOKIE_SECURE, problems);
  const secureCookie = explicitSecure ?? (appOrigin?.startsWith('https:') ?? false);
  if (!appOrigin && explicitSecure !== true) {
    warnings.push(
      'No public URL is configured (set APP_ORIGIN, or TLS_DOMAIN for built-in HTTPS). Cookies are not marked Secure and the Origin '
      + 'check falls back to the Host header. Behind your own HTTPS proxy, set APP_ORIGIN=https://your.domain.',
    );
  }

  const trustProxy = flag('TRUST_PROXY', env.TRUST_PROXY, problems) ?? Boolean(tlsDomain);

  if (problems.length > 0) throw new ConfigError(problems);

  const sqlite = chooseSqliteFile(dataDir, exists, hasItems);
  if (sqlite.warning) warnings.push(sqlite.warning);

  return {
    dataDir, sqlitePath: sqlite.path, port, tlsDomain, tlsEmail, appOrigin, secureCookie,
    trustProxy, backupHour, backupKeep, backupDir, warnings,
  };
}
