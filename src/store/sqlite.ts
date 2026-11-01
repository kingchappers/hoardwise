import { DatabaseSync } from 'node:sqlite';
import { planPatch } from './patch';
import {
  ConditionFailedError, type Item, type Key, type PatchOptions, type QueryOptions, type Store, type TxOp,
} from './types';

const MIGRATIONS: string[] = [
  `CREATE TABLE items (
     pk TEXT NOT NULL,
     sk TEXT NOT NULL,
     data TEXT NOT NULL,
     expires_at INTEGER,
     PRIMARY KEY (pk, sk)
   ) WITHOUT ROWID;
   CREATE INDEX items_expires_at ON items (expires_at) WHERE expires_at IS NOT NULL;`,
];

interface Row {
  sk: string;
  data: string;
}

// The smallest string above every string that starts with `prefix`, under SQLite's binary
// (UTF-8 byte) ordering. Null when the last character cannot be bumped safely.
export function prefixUpperBound(prefix: string): string | null {
  const last = prefix.charCodeAt(prefix.length - 1);
  const isSurrogate = last >= 0xd800 && last <= 0xdfff;
  if (isSurrogate || last === 0xd7ff || last === 0xffff) return null;
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

function pick(item: Item, attributes: string[]): Item {
  const picked: Record<string, unknown> = {};
  for (const name of attributes) {
    if (name in item) picked[name] = item[name];
  }
  return picked as Item;
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      // Before any PRAGMA that writes, so a newer database is refused untouched.
      this.assertNotNewer();
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  purgeExpired(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
    const result = this.db
      .prepare('DELETE FROM items WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(nowSeconds);
    return Number(result.changes);
  }

  // VACUUM INTO writes a consistent snapshot even while the app is writing (WAL) and refuses to overwrite an existing file.
  backupTo(path: string): void {
    this.db.prepare('VACUUM INTO ?').run(path);
  }

  async get(key: Key, _opts?: { consistent?: boolean }): Promise<Item | undefined> {
    const data = this.readData(key);
    return data === undefined ? undefined : this.toItem(key.PK, key.SK, data);
  }

  async put(item: Item, opts: { ifAbsent?: boolean } = {}): Promise<void> {
    if (!opts.ifAbsent) {
      this.write(item);
      return;
    }
    this.inTransaction(() => {
      if (this.exists(item)) throw new ConditionFailedError();
      this.write(item);
    });
  }

  async patch(key: Key, fields: Record<string, unknown>, opts: PatchOptions = {}): Promise<Item> {
    const plan = planPatch(fields, opts.defaults);
    return this.inTransaction(() => {
      const stored = this.readData(key);
      if (stored === undefined && opts.mustExist) throw new ConditionFailedError();

      const current: Record<string, unknown> = stored === undefined ? {} : JSON.parse(stored);
      const defaults = plan.defaults.filter(([name]) => current[name] === undefined);
      this.write({ ...Object.fromEntries(defaults), ...current, ...Object.fromEntries(plan.fields), PK: key.PK, SK: key.SK });
      return this.toItem(key.PK, key.SK, this.readData(key) as string);
    });
  }

  async delete(key: Key, opts: { ifPresent?: boolean } = {}): Promise<void> {
    this.inTransaction(() => {
      if (opts.ifPresent && !this.exists(key)) throw new ConditionFailedError();
      this.remove(key);
    });
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Item[]> {
    if (opts.skPrefix !== undefined && opts.skEquals !== undefined) {
      throw new Error('query takes skPrefix or skEquals, not both');
    }
    const items = this.selectRows(pk, opts).map(row => this.toItem(pk, row.sk, row.data));
    const attributes = opts.attributes;
    return attributes?.length ? items.map(item => pick(item, attributes)) : items;
  }

  async transact(ops: TxOp[]): Promise<void> {
    if (ops.length === 0) return;
    const keys = ops.map(op => ('put' in op ? op.put : op.delete));
    const identities = new Set(keys.map(key => `${key.PK}\u0000${key.SK}`));
    if (identities.size !== keys.length) {
      throw new Error('transact cannot touch the same item twice');
    }

    this.inTransaction(() => {
      ops.forEach((op, index) => {
        if ('put' in op) {
          if (op.ifAbsent && this.exists(op.put)) throw new ConditionFailedError(index);
          this.write(op.put);
          return;
        }
        if (op.ifPresent && !this.exists(op.delete)) throw new ConditionFailedError(index);
        this.remove(op.delete);
      });
    });
  }

  private assertNotNewer(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (row.user_version > MIGRATIONS.length) {
      throw new Error(
        `This database was created by a newer version of the app (schema ${row.user_version}, this build knows ${MIGRATIONS.length})`,
      );
    }
    return row.user_version;
  }

  private migrate(): void {
    const row = { user_version: this.assertNotNewer() };
    for (let version = row.user_version; version < MIGRATIONS.length; version += 1) {
      this.inTransaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  private inTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private readData(key: Key): string | undefined {
    const row = this.db.prepare('SELECT data FROM items WHERE pk = ? AND sk = ?').get(key.PK, key.SK) as
      | { data: string }
      | undefined;
    return row?.data;
  }

  private exists(key: Key): boolean {
    return this.db.prepare('SELECT 1 AS present FROM items WHERE pk = ? AND sk = ?').get(key.PK, key.SK) !== undefined;
  }

  private write(item: Item): void {
    const { PK, SK, ...attributes } = item;
    const expiresAt = typeof attributes.expiresAt === 'number' ? attributes.expiresAt : null;
    this.db
      .prepare(
        `INSERT INTO items (pk, sk, data, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (pk, sk) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
      )
      .run(PK, SK, JSON.stringify(attributes), expiresAt);
  }

  private remove(key: Key): void {
    this.db.prepare('DELETE FROM items WHERE pk = ? AND sk = ?').run(key.PK, key.SK);
  }

  private toItem(pk: string, sk: string, data: string): Item {
    return { ...JSON.parse(data), PK: pk, SK: sk };
  }

  private selectRows(pk: string, opts: QueryOptions): Row[] {
    const columns = 'SELECT sk, data FROM items WHERE pk = ?';
    if (opts.skEquals !== undefined) {
      return this.db.prepare(`${columns} AND sk = ?`).all(pk, opts.skEquals) as unknown as Row[];
    }

    const prefix = opts.skPrefix ?? '';
    if (prefix === '') {
      return this.db.prepare(`${columns} ORDER BY sk`).all(pk) as unknown as Row[];
    }

    const upper = prefixUpperBound(prefix);
    if (upper !== null) {
      return this.db.prepare(`${columns} AND sk >= ? AND sk < ? ORDER BY sk`).all(pk, prefix, upper) as unknown as Row[];
    }
    const length = Array.from(prefix).length;
    return this.db
      .prepare(`${columns} AND sk >= ? AND substr(sk, 1, ?) = ? ORDER BY sk`)
      .all(pk, prefix, length, prefix) as unknown as Row[];
  }
}
