import { planPatch } from './patch';
import {
  ConditionFailedError, type Item, type Key, type PatchOptions, type QueryOptions, type Store, type TxOp,
} from './types';

type Attributes = Record<string, unknown>;

// A JSON round trip, as the SQLite store does on every write: undefined attributes disappear, nulls stay, and nothing is shared
// with the caller.
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pick(item: Item, attributes: string[]): Item {
  const picked: Record<string, unknown> = {};
  for (const name of attributes) {
    if (name in item) picked[name] = item[name];
  }
  return picked as Item;
}

// The store the browser demo runs on: everything lives in memory and disappears with the page. It follows the same contract
// as SqliteStore and DynamoStore (see src/store/__tests__/contract.ts).
export class MemoryStore implements Store {
  private readonly partitions = new Map<string, Map<string, Attributes>>();

  async get(key: Key, _opts?: { consistent?: boolean }): Promise<Item | undefined> {
    const row = this.rowOf(key);
    return row === undefined ? undefined : this.toItem(key.PK, key.SK, row);
  }

  async put(item: Item, opts: { ifAbsent?: boolean } = {}): Promise<void> {
    if (opts.ifAbsent && this.rowOf(item) !== undefined) throw new ConditionFailedError();
    this.write(item);
  }

  async patch(key: Key, fields: Record<string, unknown>, opts: PatchOptions = {}): Promise<Item> {
    const plan = planPatch(fields, opts.defaults);
    const stored = this.rowOf(key);
    if (stored === undefined && opts.mustExist) throw new ConditionFailedError();

    const current: Attributes = stored ?? {};
    const defaults = plan.defaults.filter(([name]) => current[name] === undefined);
    this.write({ ...Object.fromEntries(defaults), ...current, ...Object.fromEntries(plan.fields), PK: key.PK, SK: key.SK });
    return this.toItem(key.PK, key.SK, this.rowOf(key) as Attributes);
  }

  async delete(key: Key, opts: { ifPresent?: boolean } = {}): Promise<void> {
    if (opts.ifPresent && this.rowOf(key) === undefined) throw new ConditionFailedError();
    this.remove(key);
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Item[]> {
    if (opts.skPrefix !== undefined && opts.skEquals !== undefined) {
      throw new Error('query takes skPrefix or skEquals, not both');
    }
    const partition = this.partitions.get(pk);
    if (partition === undefined) return [];

    const sortKeys = this.matchingSortKeys(partition, opts);
    const items = sortKeys.map(sk => this.toItem(pk, sk, partition.get(sk) as Attributes));
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

    // Every condition is checked against the state before anything is written, so a failure leaves the store untouched.
    ops.forEach((op, index) => {
      if ('put' in op) {
        if (op.ifAbsent && this.rowOf(op.put) !== undefined) throw new ConditionFailedError(index);
        return;
      }
      if (op.ifPresent && this.rowOf(op.delete) === undefined) throw new ConditionFailedError(index);
    });
    for (const op of ops) {
      if ('put' in op) this.write(op.put);
      else this.remove(op.delete);
    }
  }

  private rowOf(key: Key): Attributes | undefined {
    return this.partitions.get(key.PK)?.get(key.SK);
  }

  private write(item: Item): void {
    const { PK, SK, ...attributes } = item;
    let partition = this.partitions.get(PK);
    if (partition === undefined) {
      partition = new Map();
      this.partitions.set(PK, partition);
    }
    partition.set(SK, copy(attributes));
  }

  private remove(key: Key): void {
    this.partitions.get(key.PK)?.delete(key.SK);
  }

  private toItem(pk: string, sk: string, row: Attributes): Item {
    return { ...copy(row), PK: pk, SK: sk } as Item;
  }

  // Ascending by sort key (plain string order, which is also SQLite's order for the ASCII keys this app uses).
  private matchingSortKeys(partition: Map<string, Attributes>, opts: QueryOptions): string[] {
    if (opts.skEquals !== undefined) return partition.has(opts.skEquals) ? [opts.skEquals] : [];
    const prefix = opts.skPrefix ?? '';
    return [...partition.keys()].filter(sk => sk.startsWith(prefix)).sort();
  }
}
