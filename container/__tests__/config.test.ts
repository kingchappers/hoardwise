import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, chooseSqliteFile, isValidEmail, isValidHostname, parseConfig, sqliteHasItems } from '../config';

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
};

describe('defaults', () => {
  it('runs plain HTTP on 8080 with a /data volume and a warning about the missing public URL', () => {
    const config = parseConfig({}, () => false);
    expect(config).toMatchObject({
      dataDir: '/data', sqlitePath: '/data/hoardwise.sqlite', port: 8080, backupHour: 3, backupKeep: 7,
      backupDir: '/data/backups', trustProxy: false, secureCookie: false,
    });
    expect(config.tlsDomain).toBeUndefined();
    expect(config.appOrigin).toBeUndefined();
    expect(config.warnings.join(' ')).toMatch(/APP_ORIGIN/);
  });
});

describe('TLS_DOMAIN', () => {
  it('turns on the proxy trust, a derived https origin and Secure cookies', () => {
    const config = parseConfig({ TLS_DOMAIN: 'Budget.Example.com', TLS_EMAIL: 'me@example.com' });
    expect(config).toMatchObject({
      tlsDomain: 'budget.example.com', tlsEmail: 'me@example.com', appOrigin: 'https://budget.example.com',
      trustProxy: true, secureCookie: true, warnings: [],
    });
  });

  it.each([
    'https://budget.example.com', 'budget.example.com:8443', 'budget.example.com/path', '*.example.com', 'bad host',
    'a..b.com', '-bad.com', 'bad-.com', 'bad.com.', '10.0.0.1', 'evil.com {\nrespond "x"\n}', `${'a'.repeat(64)}.com`,
  ])('rejects the hostname %j', value => {
    expect(problemsOf({ TLS_DOMAIN: value }).join(' ')).toMatch(/TLS_DOMAIN/);
  });

  it('accepts localhost and single-label names', () => {
    expect(isValidHostname('localhost')).toBe(true);
    expect(isValidHostname('nas')).toBe(true);
  });

  it('rejects the ports Caddy needs, but allows them without TLS_DOMAIN', () => {
    for (const port of ['80', '443']) {
      expect(problemsOf({ TLS_DOMAIN: 'budget.example.com', PORT: port }).join(' '))
        .toContain('PORT must not be 80 or 443 when TLS_DOMAIN is set (Caddy uses those ports)');
    }
    expect(parseConfig({ PORT: '80' }).port).toBe(80);
  });

  it('needs a fixed port', () => {
    expect(problemsOf({ TLS_DOMAIN: 'budget.example.com', PORT: '0' }).join(' ')).toMatch(/PORT/);
  });
});

describe('TLS_EMAIL', () => {
  it.each(['a b@example.com', 'a@b.com\nrespond', 'a{b}@example.com', 'x@y"z.com', 'no-at-sign'])('rejects %j', value => {
    expect(isValidEmail(value)).toBe(false);
  });

  it('is an error without TLS_DOMAIN', () => {
    expect(problemsOf({ TLS_EMAIL: 'me@example.com' }).join(' ')).toMatch(/TLS_EMAIL/);
  });
});

describe('APP_ORIGIN', () => {
  it('normalises a plain URL and derives Secure from the scheme', () => {
    expect(parseConfig({ APP_ORIGIN: 'https://budget.example.com/' })).toMatchObject({ appOrigin: 'https://budget.example.com', secureCookie: true, warnings: [] });
    expect(parseConfig({ APP_ORIGIN: 'http://nas.local:8080' })).toMatchObject({ appOrigin: 'http://nas.local:8080', secureCookie: false });
  });

  it.each(['budget.example.com', 'https://u:p@budget.example.com', 'https://budget.example.com/path', 'https://budget.example.com?x=1', 'ftp://x.com'])(
    'rejects %j', value => {
      expect(problemsOf({ APP_ORIGIN: value }).join(' ')).toMatch(/APP_ORIGIN/);
    });

  it('must match TLS_DOMAIN by host (any port) and be https', () => {
    expect(parseConfig({ TLS_DOMAIN: 'localhost', APP_ORIGIN: 'https://localhost:8443' }).appOrigin).toBe('https://localhost:8443');
    expect(problemsOf({ TLS_DOMAIN: 'budget.example.com', APP_ORIGIN: 'https://other.example.com' }).join(' ')).toMatch(/same host/);
    expect(problemsOf({ TLS_DOMAIN: 'budget.example.com', APP_ORIGIN: 'http://budget.example.com' }).join(' ')).toMatch(/https/);
  });
});

describe('COOKIE_SECURE and TRUST_PROXY', () => {
  it('lets an explicit COOKIE_SECURE win and rejects other values', () => {
    expect(parseConfig({ COOKIE_SECURE: 'true' }).secureCookie).toBe(true);
    expect(parseConfig({ COOKIE_SECURE: 'true' }).warnings).toEqual([]);
    expect(parseConfig({ APP_ORIGIN: 'https://x.example.com', COOKIE_SECURE: 'false' }).secureCookie).toBe(false);
    expect(problemsOf({ COOKIE_SECURE: 'yes' }).join(' ')).toMatch(/COOKIE_SECURE/);
  });

  it('reads TRUST_PROXY explicitly and rejects other values', () => {
    expect(parseConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(parseConfig({ TLS_DOMAIN: 'budget.example.com', TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(problemsOf({ TRUST_PROXY: '1' }).join(' ')).toMatch(/TRUST_PROXY/);
  });
});

describe('numbers and paths', () => {
  it.each([
    [{ PORT: '70000' }, /PORT/], [{ PORT: 'abc' }, /PORT/], [{ PORT: '-1' }, /PORT/],
    [{ BACKUP_HOUR: '24' }, /BACKUP_HOUR/], [{ BACKUP_HOUR: '3.5' }, /BACKUP_HOUR/],
    [{ BACKUP_KEEP: '-1' }, /BACKUP_KEEP/], [{ BACKUP_KEEP: '1000' }, /BACKUP_KEEP/],
    [{ DATA_DIR: 'relative/path' }, /DATA_DIR/], [{ DATA_DIR: '/data with space' }, /DATA_DIR/], [{ BACKUP_DIR: 'backups' }, /BACKUP_DIR/],
  ])('rejects %j', (env, pattern) => {
    expect(problemsOf(env).join(' ')).toMatch(pattern);
  });

  it('accepts the boundaries and turns backups off with BACKUP_KEEP=0', () => {
    expect(parseConfig({ BACKUP_HOUR: '0', BACKUP_KEEP: '0', PORT: '0' })).toMatchObject({ backupHour: 0, backupKeep: 0, port: 0 });
    expect(parseConfig({ BACKUP_HOUR: '23', BACKUP_KEEP: '365', PORT: '65535' })).toMatchObject({ backupHour: 23, backupKeep: 365, port: 65535 });
  });

  it('reports every problem at once', () => {
    const problems = problemsOf({ PORT: 'x', BACKUP_HOUR: '99', TLS_DOMAIN: 'bad host' });
    expect(problems).toHaveLength(3);
    expect(problems.some(problem => problem.startsWith('PORT '))).toBe(true);
    expect(problems.some(problem => problem.startsWith('BACKUP_HOUR '))).toBe(true);
    expect(problems.some(problem => problem.startsWith('TLS_DOMAIN '))).toBe(true);
  });
});

describe('hostname injection and length', () => {
  const hostnameWithLabels = (lengths: number[]): string => lengths.map(length => 'a'.repeat(length)).join('.');

  it.each(['budget.example.com\n', 'budget.example.com\r', 'budget\texample.com', 'budget example.com', '::1', '[::1]'])(
    'rejects %j', value => {
      expect(isValidHostname(value)).toBe(false);
    });

  it('accepts a hostname of exactly 253 characters', () => {
    const hostname = hostnameWithLabels([63, 63, 63, 61]);
    expect(hostname.length).toBe(253);
    expect(isValidHostname(hostname)).toBe(true);
  });

  it('rejects a hostname of 254 characters even when every label fits', () => {
    const hostname = hostnameWithLabels([63, 63, 63, 62]);
    expect(hostname.length).toBe(254);
    expect(isValidHostname(hostname)).toBe(false);
  });
});

describe('email injection', () => {
  it('accepts a plain address', () => {
    expect(isValidEmail('a@example.com')).toBe(true);
  });

  it.each(['a`b@example.com', 'a\\b@example.com', "a'b@example.com", 'a\tb@example.com', 'a@example.com\r', 'a@example.com\n'])(
    'rejects the single bad character in %j', value => {
      expect(isValidEmail(value)).toBe(false);
    });
});

describe('directories', () => {
  it.each([
    [{ BACKUP_DIR: '/backups with space' }, /BACKUP_DIR/],
    [{ BACKUP_DIR: '/back\nups' }, /BACKUP_DIR/],
    [{ BACKUP_DIR: '/data/../x' }, /BACKUP_DIR/],
    [{ BACKUP_DIR: '/' }, /BACKUP_DIR/],
    [{ DATA_DIR: '/data/../x' }, /DATA_DIR/],
    [{ DATA_DIR: '/' }, /DATA_DIR/],
  ])('rejects %j', (env, pattern) => {
    expect(problemsOf(env).join(' ')).toMatch(pattern);
  });

  it('accepts a backup directory of letters, digits, dots, dashes and underscores', () => {
    expect(parseConfig({ BACKUP_DIR: '/var/backups-1/x_y.z' }).backupDir).toBe('/var/backups-1/x_y.z');
  });
});

describe('the database file', () => {
  const existing = (...paths: string[]) => (path: string): boolean => paths.includes(path);

  it('creates hoardwise.sqlite for a new install', () => {
    expect(chooseSqliteFile('/data', existing())).toEqual({ path: '/data/hoardwise.sqlite' });
  });

  it('keeps using budget.sqlite for an install from before 0.3.0', () => {
    expect(chooseSqliteFile('/data', existing('/data/budget.sqlite'))).toEqual({ path: '/data/budget.sqlite' });
  });

  it('uses hoardwise.sqlite when it is the only one', () => {
    expect(chooseSqliteFile('/data', existing('/data/hoardwise.sqlite'))).toEqual({ path: '/data/hoardwise.sqlite' });
  });

  it('uses hoardwise.sqlite and warns, naming both files, when both exist', () => {
    const chosen = chooseSqliteFile('/data', existing('/data/hoardwise.sqlite', '/data/budget.sqlite'));
    expect(chosen.path).toBe('/data/hoardwise.sqlite');
    expect(chosen.warning).toContain('hoardwise.sqlite');
    expect(chosen.warning).toContain('budget.sqlite');
  });

  describe('when both files exist and one is empty', () => {
    const both = existing('/data/hoardwise.sqlite', '/data/budget.sqlite');
    const populated = (...paths: string[]) => (path: string): boolean | undefined => paths.includes(path);

    it('uses budget.sqlite when hoardwise.sqlite has no data and budget.sqlite has some', () => {
      const chosen = chooseSqliteFile('/data', both, populated('/data/budget.sqlite'));
      expect(chosen.path).toBe('/data/budget.sqlite');
      expect(chosen.warning).toContain('hoardwise.sqlite is empty');
      expect(chosen.warning).toContain('Neither file was changed');
    });

    it('keeps hoardwise.sqlite when it has data, whatever budget.sqlite holds', () => {
      for (const filled of [['/data/hoardwise.sqlite'], ['/data/hoardwise.sqlite', '/data/budget.sqlite']]) {
        expect(chooseSqliteFile('/data', both, populated(...filled)).path).toBe('/data/hoardwise.sqlite');
      }
    });

    it('keeps hoardwise.sqlite when both are empty', () => {
      expect(chooseSqliteFile('/data', both, populated()).path).toBe('/data/hoardwise.sqlite');
    });

    it('keeps hoardwise.sqlite when either file cannot be read', () => {
      const unreadable = (path: string): boolean | undefined => (path.endsWith('budget.sqlite') ? true : undefined);
      expect(chooseSqliteFile('/data', both, unreadable).path).toBe('/data/hoardwise.sqlite');
      const otherWay = (path: string): boolean | undefined => (path.endsWith('budget.sqlite') ? undefined : false);
      expect(chooseSqliteFile('/data', both, otherWay).path).toBe('/data/hoardwise.sqlite');
    });

    it('does not look inside either file unless both exist', () => {
      const looked: string[] = [];
      const probe = (path: string): boolean | undefined => { looked.push(path); return true; };
      chooseSqliteFile('/data', existing('/data/budget.sqlite'), probe);
      chooseSqliteFile('/data', existing('/data/hoardwise.sqlite'), probe);
      chooseSqliteFile('/data', existing(), probe);
      expect(looked).toEqual([]);
    });

    it('is applied by parseConfig, with the warning added to the others', () => {
      const config = parseConfig({}, both, populated('/data/budget.sqlite'));
      expect(config.sqlitePath).toBe('/data/budget.sqlite');
      expect(config.warnings.join(' ')).toContain('hoardwise.sqlite is empty');
    });
  });

  it('is applied by parseConfig, with the warning added to the others', () => {
    expect(parseConfig({}, existing('/data/budget.sqlite')).sqlitePath).toBe('/data/budget.sqlite');
    const both = parseConfig({}, existing('/data/hoardwise.sqlite', '/data/budget.sqlite'));
    expect(both.sqlitePath).toBe('/data/hoardwise.sqlite');
    expect(both.warnings.join(' ')).toMatch(/budget\.sqlite/);
  });

  it('only asks whether the two files exist, and follows DATA_DIR', () => {
    const asked: string[] = [];
    parseConfig({ DATA_DIR: '/vol' }, path => { asked.push(path); return false; });
    expect(asked.sort()).toEqual(['/vol/budget.sqlite', '/vol/hoardwise.sqlite']);
  });
});

describe('sqliteHasItems', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hw-probe-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function database(name: string, setup: (db: DatabaseSync) => void): string {
    const path = join(dir, name);
    const db = new DatabaseSync(path);
    setup(db);
    db.close();
    return path;
  }

  it('is true for a database with an item', () => {
    const path = database('full.sqlite', db => {
      db.exec('CREATE TABLE items (pk TEXT, sk TEXT, data TEXT)');
      db.exec("INSERT INTO items VALUES ('USER#a', 'CAT#x', '{}')");
    });
    expect(sqliteHasItems(path)).toBe(true);
  });

  it('is false for a database with an empty items table, or no tables at all', () => {
    expect(sqliteHasItems(database('empty.sqlite', db => db.exec('CREATE TABLE items (pk TEXT, sk TEXT, data TEXT)')))).toBe(false);
    expect(sqliteHasItems(database('blank.sqlite', () => undefined))).toBe(false);
  });

  it('is unknown for a file that is not a database, and a missing file', () => {
    writeFileSync(join(dir, 'junk.sqlite'), 'this is not a database file at all, just text');
    expect(sqliteHasItems(join(dir, 'junk.sqlite'))).toBeUndefined();
    expect(sqliteHasItems(join(dir, 'missing.sqlite'))).toBeUndefined();
  });

  it('changes neither the file nor the folder', () => {
    const path = database('full.sqlite', db => {
      db.exec('CREATE TABLE items (pk TEXT, sk TEXT, data TEXT)');
      db.exec("INSERT INTO items VALUES ('USER#a', 'CAT#x', '{}')");
    });
    const before = { files: readdirSync(dir).sort(), bytes: readFileSync(path) };
    sqliteHasItems(path);
    expect(readdirSync(dir).sort()).toEqual(before.files);
    expect(readFileSync(path).equals(before.bytes)).toBe(true);
  });
});
