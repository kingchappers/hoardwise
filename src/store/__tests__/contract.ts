import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConditionFailedError, type Store } from '../types';

export interface ContractBackend {
  create(): Promise<Store>;
  destroy?(): Promise<void>;
}

const newUser = (): string => `USER#${crypto.randomUUID()}`;

export function runStoreContract(name: string, backend: ContractBackend, options: { skip?: boolean } = {}): void {
  const suite = options.skip ? describe.skip : describe;

  suite(`Store contract: ${name}`, () => {
    let store: Store;

    beforeAll(async () => { store = await backend.create(); });
    afterAll(async () => { await backend.destroy?.(); });

    describe('get and put', () => {
      it('returns undefined for a missing item', async () => {
        expect(await store.get({ PK: newUser(), SK: 'CAT#missing' })).toBeUndefined();
      });

      it('returns the item for a consistent read', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'CAT#a', name: 'Food' });
        expect(await store.get({ PK, SK: 'CAT#a' }, { consistent: true })).toEqual({ PK, SK: 'CAT#a', name: 'Food' });
      });

      it('stores an item and returns it with its keys', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'CAT#a', name: 'Food', amount: 350, archivedAt: null });
        expect(await store.get({ PK, SK: 'CAT#a' })).toEqual({ PK, SK: 'CAT#a', name: 'Food', amount: 350, archivedAt: null });
      });

      it('replaces the whole item on put', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'CAT#a', name: 'Food', extra: true });
        await store.put({ PK, SK: 'CAT#a', name: 'Dining' });
        expect(await store.get({ PK, SK: 'CAT#a' })).toEqual({ PK, SK: 'CAT#a', name: 'Dining' });
      });

      it('drops undefined attributes instead of failing', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'TXN#2026-10#t1', amount: 100, recurringId: undefined });
        expect(await store.get({ PK, SK: 'TXN#2026-10#t1' })).toEqual({ PK, SK: 'TXN#2026-10#t1', amount: 100 });
      });

      it('round-trips nulls, arrays and nested objects exactly', async () => {
        const PK = newUser();
        const value = { quietStart: null, list: [1, 'two', null], nested: { ok: true, n: 0 } };
        await store.put({ PK, SK: 'PUSHSUB#x', ...value });
        expect(await store.get({ PK, SK: 'PUSHSUB#x' })).toEqual({ PK, SK: 'PUSHSUB#x', ...value });
      });

      it('refuses to overwrite with ifAbsent and keeps the original', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'CAT#a', name: 'First' }, { ifAbsent: true });
        await expect(store.put({ PK, SK: 'CAT#a', name: 'Second' }, { ifAbsent: true }))
          .rejects.toBeInstanceOf(ConditionFailedError);
        expect(await store.get({ PK, SK: 'CAT#a' })).toMatchObject({ name: 'First' });
      });
    });

    describe('patch', () => {
      it('creates the item when it is missing', async () => {
        const PK = newUser();
        const item = await store.patch({ PK, SK: 'PUSHSUB#x' }, { hour: 8 });
        expect(item).toEqual({ PK, SK: 'PUSHSUB#x', hour: 8 });
        expect(await store.get({ PK, SK: 'PUSHSUB#x' })).toEqual(item);
      });

      it('merges into an existing item and returns the result', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'CAT#a', name: 'Food', icon: 'star' });
        const item = await store.patch({ PK, SK: 'CAT#a' }, { name: 'Dining' }, { mustExist: true });
        expect(item).toEqual({ PK, SK: 'CAT#a', name: 'Dining', icon: 'star' });
      });

      it('throws and creates nothing when mustExist is set and the item is missing', async () => {
        const PK = newUser();
        await expect(store.patch({ PK, SK: 'CAT#gone' }, { name: 'x' }, { mustExist: true }))
          .rejects.toBeInstanceOf(ConditionFailedError);
        expect(await store.get({ PK, SK: 'CAT#gone' })).toBeUndefined();
      });

      it('applies the patch when every ifEquals attribute matches the stored value', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'CAT#a', name: 'Food', icon: 'star' });
        const item = await store.patch({ PK, SK: 'CAT#a' }, { name: 'FOOD' }, { ifEquals: { name: 'Food', icon: 'star' } });
        expect(item).toEqual({ PK, SK: 'CAT#a', name: 'FOOD', icon: 'star' });
      });

      it('throws and changes nothing when an ifEquals attribute differs', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'CAT#a', name: 'Food', icon: 'star' });
        await expect(store.patch({ PK, SK: 'CAT#a' }, { icon: 'moon' }, { ifEquals: { name: 'Dining' } }))
          .rejects.toBeInstanceOf(ConditionFailedError);
        expect(await store.get({ PK, SK: 'CAT#a' })).toEqual({ PK, SK: 'CAT#a', name: 'Food', icon: 'star' });
      });

      it('throws and creates nothing when ifEquals is set and the item is missing', async () => {
        const PK = newUser();
        await expect(store.patch({ PK, SK: 'CAT#gone' }, { name: 'x' }, { ifEquals: { name: 'y' } }))
          .rejects.toBeInstanceOf(ConditionFailedError);
        expect(await store.get({ PK, SK: 'CAT#gone' })).toBeUndefined();
      });

      it('applies defaults only to attributes that are not already set', async () => {
        const PK = newUser();
        await store.patch({ PK, SK: 'PUSHSUB#x' }, { hour: 8 }, { defaults: { createdAt: 'first' } });
        await store.patch({ PK, SK: 'PUSHSUB#x' }, { hour: 9 }, { defaults: { createdAt: 'second' } });
        expect(await store.get({ PK, SK: 'PUSHSUB#x' })).toMatchObject({ hour: 9, createdAt: 'first' });
      });

      it('ignores undefined fields and keeps null ones', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'RECUR#r', anchorDate: '2026-01-01', leadDays: 3 });
        const item = await store.patch({ PK, SK: 'RECUR#r' }, { anchorDate: null, leadDays: undefined });
        expect(item).toEqual({ PK, SK: 'RECUR#r', anchorDate: null, leadDays: 3 });
      });

      it('rejects an empty patch', async () => {
        await expect(store.patch({ PK: newUser(), SK: 'CAT#a' }, {})).rejects.toThrow('at least one field');
      });
    });

    describe('delete', () => {
      it('removes an item and tolerates a missing one', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'CAT#a', name: 'Food' });
        await store.delete({ PK, SK: 'CAT#a' });
        await store.delete({ PK, SK: 'CAT#a' });
        expect(await store.get({ PK, SK: 'CAT#a' })).toBeUndefined();
      });

      it('throws with ifPresent when the item is missing', async () => {
        await expect(store.delete({ PK: newUser(), SK: 'CAT#a' }, { ifPresent: true }))
          .rejects.toBeInstanceOf(ConditionFailedError);
      });
    });

    describe('query', () => {
      async function seed(PK: string, sks: string[]): Promise<void> {
        for (const SK of sks) await store.put({ PK, SK, n: SK.length });
      }

      it('returns the whole partition in ascending SK order and nothing from other users', async () => {
        const PK = newUser();
        await seed(PK, ['TXN#2026-10#b', 'CAT#a', 'TXN#2026-09#z']);
        await seed(newUser(), ['CAT#other']);
        const items = await store.query(PK);
        expect(items.map(item => item.SK)).toEqual(['CAT#a', 'TXN#2026-09#z', 'TXN#2026-10#b']);
      });

      it('treats an empty prefix as the whole partition', async () => {
        const PK = newUser();
        await seed(PK, ['CAT#a', 'POT#a']);
        expect(await store.query(PK, { skPrefix: '' })).toHaveLength(2);
      });

      it('filters by SK prefix', async () => {
        const PK = newUser();
        await seed(PK, ['TXN#2026-10#a', 'TXN#2026-10#b', 'TXN#2026-11#a', 'CAT#a']);
        const items = await store.query(PK, { skPrefix: 'TXN#2026-10' });
        expect(items.map(item => item.SK)).toEqual(['TXN#2026-10#a', 'TXN#2026-10#b']);
      });

      it('does not treat an underscore in a prefix as a wildcard', async () => {
        const PK = newUser();
        await seed(PK, ['TXN#2026-10#a_b', 'TXN#2026-10#axb', 'TXN#2026-10#a%b']);
        expect((await store.query(PK, { skPrefix: 'TXN#2026-10#a_' })).map(item => item.SK)).toEqual(['TXN#2026-10#a_b']);
        expect((await store.query(PK, { skPrefix: 'TXN#2026-10#a%' })).map(item => item.SK)).toEqual(['TXN#2026-10#a%b']);
      });

      it('matches one SK exactly with skEquals', async () => {
        const PK = newUser();
        await seed(PK, ['CAT#a', 'CAT#ab']);
        expect((await store.query(PK, { skEquals: 'CAT#a' })).map(item => item.SK)).toEqual(['CAT#a']);
        expect(await store.query(PK, { skEquals: 'CAT#none' })).toEqual([]);
      });

      it('returns only the named attributes when asked', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'POT#a', categoryId: 'a', monthlyAmount: 5, archivedAt: null });
        expect(await store.query(PK, { skPrefix: 'POT#', attributes: ['SK'] })).toEqual([{ SK: 'POT#a' }]);
        expect(await store.query(PK, { skPrefix: 'POT#', attributes: ['categoryId'] })).toEqual([{ categoryId: 'a' }]);
      });

      it('treats an empty attributes list as no projection', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'POT#a', categoryId: 'a' });
        expect(await store.query(PK, { skPrefix: 'POT#', attributes: [] })).toEqual([{ PK, SK: 'POT#a', categoryId: 'a' }]);
      });

      it('rejects skPrefix and skEquals together', async () => {
        await expect(store.query(newUser(), { skPrefix: 'A', skEquals: 'B' })).rejects.toThrow('not both');
      });

      it('returns every item of a partition larger than one page', async () => {
        const PK = newUser();
        const pad = 'x'.repeat(5000);
        await Promise.all(Array.from({ length: 300 }, (_, index) => (
          store.put({ PK, SK: `TXN#2026-10#${String(index).padStart(4, '0')}`, pad })
        )));
        expect(await store.query(PK, { skPrefix: 'TXN#' })).toHaveLength(300);
      }, 60000);
    });

    describe('transact', () => {
      it('applies every operation together', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'TXN#2026-10#t1', amount: 5 });
        await store.transact([
          { delete: { PK, SK: 'TXN#2026-10#t1' }, ifPresent: true },
          { put: { PK, SK: 'TXN#2026-11#t1', amount: 5 }, ifAbsent: true },
        ]);
        expect(await store.get({ PK, SK: 'TXN#2026-10#t1' })).toBeUndefined();
        expect(await store.get({ PK, SK: 'TXN#2026-11#t1' })).toMatchObject({ amount: 5 });
      });

      it('rolls everything back and reports the index of a failed ifAbsent', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'TXN#2026-10#t1', amount: 1 });
        await expect(store.transact([
          { put: { PK, SK: 'TXN#2026-11#t1', amount: 1 } },
          { put: { PK, SK: 'TXN#2026-10#t1', amount: 2 }, ifAbsent: true },
        ])).rejects.toMatchObject({ name: 'ConditionFailedError', failedIndex: 1 });
        expect(await store.get({ PK, SK: 'TXN#2026-11#t1' })).toBeUndefined();
        expect(await store.get({ PK, SK: 'TXN#2026-10#t1' })).toMatchObject({ amount: 1 });
      });

      it('reports index 0 and index 1 for a failed ifPresent delete', async () => {
        const PK = newUser();
        await store.put({ PK, SK: 'B', n: 1 });
        await expect(store.transact([
          { delete: { PK, SK: 'A' }, ifPresent: true },
          { delete: { PK, SK: 'B' } },
        ])).rejects.toMatchObject({ failedIndex: 0 });
        await expect(store.transact([
          { delete: { PK, SK: 'B' }, ifPresent: true },
          { delete: { PK, SK: 'A' }, ifPresent: true },
        ])).rejects.toMatchObject({ failedIndex: 1 });
        expect(await store.get({ PK, SK: 'B' })).toMatchObject({ n: 1 });
      });

      it('rejects two operations on the same item', async () => {
        const PK = newUser();
        await expect(store.transact([
          { put: { PK, SK: 'A', n: 1 } },
          { delete: { PK, SK: 'A' } },
        ])).rejects.toThrow();
      });

      it('does nothing for an empty list', async () => {
        await expect(store.transact([])).resolves.toBeUndefined();
      });
    });
  });
}
