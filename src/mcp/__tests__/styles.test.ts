import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory';
import {
  MAX_STYLES, deleteStyle, getDefaultStyle, listStyles, saveStyle, validateStyleText,
} from '../styles';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const later = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
const save = (store: MemoryStore, name: string, extra: { makeDefault?: boolean; renameFrom?: string; user?: string; at?: Date } = {}) =>
  saveStyle(store, extra.user ?? 'u1', {
    name, description: 'One big figure, few colours', makeDefault: extra.makeDefault, renameFrom: extra.renameFrom,
  }, extra.at ?? NOW);

let store: MemoryStore;
beforeEach(() => { store = new MemoryStore(); });

describe('validateStyleText', () => {
  const check = (name: string, description: string) => validateStyleText({ name, description });

  it.each([
    ['empty name', '', 'ok'],
    ['41-character name', 'x'.repeat(41), 'ok'],
    ['201-character description', 'Name', 'x'.repeat(201)],
    ['empty description', 'Name', '  '],
    ['html', 'Name', '<b>bold</b>'],
    ['closing tag', 'Name', 'a </ b'],
    ['https link', 'Name', 'see https://x.test'],
    ['http link', 'Name', 'see HTTP://x.test'],
    ['www', 'Name', 'go to www.x.test'],
    ['markdown link', 'Name', '[a](b)'],
    ['control character', 'Name', 'a\u0007b'],
    ['newline', 'Name', 'a\nb'],
    ['delete character', 'Na\u007Fme', 'fine'],
    ['C1 control in the name', 'Na\u0085me', 'fine'],
    ['C1 control in the description', 'Name', 'a\u009Fb'],
    ['line separator in the name', 'Na\u2028me', 'fine'],
    ['paragraph separator in the description', 'Name', 'a\u2029b'],
    ['left-to-right mark in the name', 'Na\u200Eme', 'fine'],
    ['right-to-left mark in the description', 'Name', 'a\u200Fb'],
    ['bidi embedding in the name', 'Na\u202Ame', 'fine'],
    ['bidi override in the description', 'Name', 'a\u202Eb'],
    ['bidi isolate in the name', 'Na\u2066me', 'fine'],
    ['pop directional isolate in the description', 'Name', 'a\u2069b'],
  ])('refuses %s', (_label, name, description) => {
    const result = check(name, description);
    expect(result.ok).toBe(false);
  });

  it('names the field in the message', () => {
    expect(check('', 'fine')).toMatchObject({ ok: false, message: expect.stringContaining('name') });
    expect(check('Name', '')).toMatchObject({ ok: false, message: expect.stringContaining('description') });
  });

  it('refuses non-text', () => {
    expect(validateStyleText({ name: 5, description: 'x' }).ok).toBe(false);
    expect(validateStyleText({ name: 'x', description: undefined }).ok).toBe(false);
  });

  it('accepts and trims plain text', () => {
    expect(check('  Big number ', ' One big figure, few colours, large text ')).toEqual({
      ok: true, name: 'Big number', description: 'One big figure, few colours, large text',
    });
    expect(check('x'.repeat(40), 'y'.repeat(200)).ok).toBe(true);
  });
});

describe('saveStyle', () => {
  it('creates a style, not default unless asked', async () => {
    const result = await save(store, 'Big number');
    expect(result).toMatchObject({ created: true, style: { name: 'Big number', isDefault: false, createdAt: NOW.toISOString() } });
    if ('error' in result) throw new Error('unexpected');
    expect(result.style.styleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getDefaultStyle(store, 'u1')).toBeUndefined();
  });

  it('refuses invalid text', async () => {
    expect(await save(store, '')).toMatchObject({ error: expect.stringContaining('name') });
  });

  it('updates in place when the name matches ignoring case', async () => {
    const first = await save(store, 'Big number');
    const second = await saveStyle(store, 'u1', {
      name: 'BIG NUMBER', description: 'Changed', makeDefault: undefined, renameFrom: undefined,
    }, later(5));
    if ('error' in first || 'error' in second) throw new Error('unexpected');
    expect(second.created).toBe(false);
    expect(second.style).toMatchObject({
      styleId: first.style.styleId, description: 'Changed', createdAt: NOW.toISOString(), updatedAt: later(5).toISOString(),
    });
    expect(await listStyles(store, 'u1')).toHaveLength(1);
  });

  it('renames with renameFrom', async () => {
    const first = await save(store, 'Big number');
    const renamed = await save(store, 'Headline', { renameFrom: 'big number' });
    if ('error' in first || 'error' in renamed) throw new Error('unexpected');
    expect(renamed.created).toBe(false);
    expect(renamed.style.styleId).toBe(first.style.styleId);
    expect((await listStyles(store, 'u1')).map(s => s.name)).toEqual(['Headline']);
  });

  it('refuses a rename onto another style, and a rename of a missing style', async () => {
    await save(store, 'One');
    await save(store, 'Two');
    expect(await save(store, 'two', { renameFrom: 'One' })).toMatchObject({ error: expect.stringContaining('already') });
    expect(await save(store, 'x', { renameFrom: 'Nope' })).toMatchObject({ error: 'There is no saved style with that name.' });
    expect(await listStyles(store, 'u1')).toHaveLength(2);
  });

  it('refuses the 21st style, naming the cap', async () => {
    for (let i = 0; i < MAX_STYLES; i += 1) await save(store, `Style ${i}`);
    expect(await save(store, 'One too many')).toMatchObject({ error: expect.stringContaining(String(MAX_STYLES)) });
    expect(await save(store, 'style 3')).toMatchObject({ created: false });
  });

  it('makeDefault true leaves exactly one default and clears the previous one', async () => {
    await save(store, 'One', { makeDefault: true });
    await save(store, 'Two', { makeDefault: true });
    const styles = await listStyles(store, 'u1');
    expect(styles.filter(s => s.isDefault).map(s => s.name)).toEqual(['Two']);
    expect(styles[0].name).toBe('Two');
  });

  it('keeps the default when makeDefault is undefined', async () => {
    await save(store, 'One', { makeDefault: true });
    await save(store, 'One');
    expect((await getDefaultStyle(store, 'u1'))?.name).toBe('One');
  });

  it('makeDefault false on the default clears it, but leaves another default alone', async () => {
    await save(store, 'One', { makeDefault: true });
    await save(store, 'Two');
    await save(store, 'Two', { makeDefault: false });
    expect((await getDefaultStyle(store, 'u1'))?.name).toBe('One');
    await save(store, 'One', { makeDefault: false });
    expect(await getDefaultStyle(store, 'u1')).toBeUndefined();
    expect(await store.get({ PK: 'USER#u1', SK: 'STYLEDEFAULT' })).toBeUndefined();
  });

  it('never returns the marker as a style', async () => {
    await save(store, 'One', { makeDefault: true });
    expect(await store.query('USER#u1', { skPrefix: 'STYLE#' })).toHaveLength(1);
  });

  it('treats a marker naming a missing style as no default', async () => {
    await save(store, 'One');
    await store.put({ PK: 'USER#u1', SK: 'STYLEDEFAULT', styleId: 'gone' });
    expect(await getDefaultStyle(store, 'u1')).toBeUndefined();
    expect((await listStyles(store, 'u1')).some(s => s.isDefault)).toBe(false);
  });
});

describe('listStyles ordering', () => {
  it('puts the default first, then newest update, then name', async () => {
    await save(store, 'Old', { at: NOW });
    await save(store, 'B', { at: later(5) });
    await save(store, 'A', { at: later(5) });
    await save(store, 'Pinned', { at: later(1), makeDefault: true });
    expect((await listStyles(store, 'u1')).map(s => s.name)).toEqual(['Pinned', 'A', 'B', 'Old']);
  });
});

describe('deleteStyle', () => {
  it('deletes by name ignoring case and returns false for an unknown name', async () => {
    await save(store, 'One');
    expect(await deleteStyle(store, 'u1', 'nope')).toBe(false);
    expect(await deleteStyle(store, 'u1', 'ONE')).toBe(true);
    expect(await listStyles(store, 'u1')).toEqual([]);
  });

  it('removes the default and its marker together', async () => {
    await save(store, 'One', { makeDefault: true });
    await save(store, 'Two');
    expect(await deleteStyle(store, 'u1', 'One')).toBe(true);
    expect(await getDefaultStyle(store, 'u1')).toBeUndefined();
    expect(await store.get({ PK: 'USER#u1', SK: 'STYLEDEFAULT' })).toBeUndefined();
    expect(await listStyles(store, 'u1')).toHaveLength(1);
  });

  it('reports false for the loser of two concurrent deletes', async () => {
    await save(store, 'One', { makeDefault: true });
    const results = await Promise.all([deleteStyle(store, 'u1', 'One'), deleteStyle(store, 'u1', 'One')]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

class YieldingStore extends MemoryStore {
  override async put(item: Parameters<MemoryStore['put']>[0], opts?: Parameters<MemoryStore['put']>[1]): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, item.SK === 'STYLEDEFAULT' ? 0 : 5));
    await super.put(item, opts);
  }

  override async transact(ops: Parameters<MemoryStore['transact']>[0]): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 5));
    await super.transact(ops);
  }
}

async function expectConsistentNames(target: MemoryStore): Promise<void> {
  const styles = await listStyles(target, 'u1');
  const keys = await target.query('USER#u1', { skPrefix: 'STYLENAME#' });
  expect(new Set(styles.map(s => s.name.toLowerCase())).size).toBe(styles.length);
  expect(keys).toHaveLength(styles.length);
  for (const key of keys) {
    const owner = styles.find(s => s.styleId === key.styleId);
    expect(owner).toBeDefined();
    expect(key.SK).toBe(`STYLENAME#${owner?.name.toLowerCase()}`);
  }
}

describe('unique names under concurrency', () => {
  it('lets only one of two concurrent saves of the same new name create it', async () => {
    const racing = new YieldingStore();
    const results = await Promise.all([save(racing, 'Fresh'), save(racing, 'fresh')]);
    expect(results.filter(r => 'style' in r)).toHaveLength(1);
    expect(results.filter(r => 'error' in r)).toEqual([{ error: expect.stringContaining('already') }]);
    expect(await listStyles(racing, 'u1')).toHaveLength(1);
    await expectConsistentNames(racing);
  });

  it('leaves no duplicate and no orphan key when two renames collide', async () => {
    const racing = new YieldingStore();
    await save(racing, 'One');
    await save(racing, 'Two');
    const results = await Promise.all([save(racing, 'Fresh', { renameFrom: 'One' }), save(racing, 'Fresh', { renameFrom: 'Two' })]);
    expect(results.filter(r => 'style' in r)).toHaveLength(1);
    expect((await listStyles(racing, 'u1')).filter(s => s.name === 'Fresh')).toHaveLength(1);
    await expectConsistentNames(racing);
  });

  it('frees the old name on rename and on delete', async () => {
    await save(store, 'One');
    await save(store, 'Two', { renameFrom: 'One' });
    expect(await save(store, 'One')).toMatchObject({ created: true });
    expect(await deleteStyle(store, 'u1', 'Two')).toBe(true);
    expect(await save(store, 'two')).toMatchObject({ created: true });
    await expectConsistentNames(store);
  });

  it('keeps the key when only the case of the name changes', async () => {
    await save(store, 'One');
    await save(store, 'ONE', { renameFrom: 'one' });
    expect((await listStyles(store, 'u1')).map(s => s.name)).toEqual(['ONE']);
    await expectConsistentNames(store);
  });

  it('never lists the name keys or the default marker as styles', async () => {
    await save(store, 'One', { makeDefault: true });
    await save(store, 'Two');
    expect(await listStyles(store, 'u1')).toHaveLength(2);
    expect(await store.query('USER#u1', { skPrefix: 'STYLE#' })).toHaveLength(2);
    expect(await store.query('USER#u1', { skPrefix: 'STYLENAME#' })).toHaveLength(2);
  });
});

describe('a style deleted mid-update', () => {
  class DeleteAfterRead extends MemoryStore {
    afterQuery: (() => Promise<void>) | undefined;
    override async query(pk: string, opts?: Parameters<MemoryStore['query']>[1]) {
      const rows = await super.query(pk, opts);
      const hook = this.afterQuery;
      this.afterQuery = undefined;
      if (hook) await hook();
      return rows;
    }
  }

  it('is not resurrected by an update of its description', async () => {
    const racing = new DeleteAfterRead();
    await save(racing, 'One');
    racing.afterQuery = async () => { await deleteStyle(racing, 'u1', 'One'); };
    const result = await saveStyle(racing, 'u1', { name: 'One', description: 'Changed', makeDefault: undefined, renameFrom: undefined }, NOW);
    expect(result).toMatchObject({ error: expect.stringContaining('no longer exists') });
    expect(await listStyles(racing, 'u1')).toEqual([]);
    expect(await racing.query('USER#u1', { skPrefix: 'STYLENAME#' })).toEqual([]);
  });

  it('is not resurrected by a rename', async () => {
    const racing = new DeleteAfterRead();
    await save(racing, 'One');
    racing.afterQuery = async () => { await deleteStyle(racing, 'u1', 'One'); };
    const result = await save(racing, 'Two', { renameFrom: 'One' });
    expect(result).toMatchObject({ error: expect.stringContaining('no longer exists') });
    expect(await racing.query('USER#u1')).toEqual([]);
  });
});

describe('lookup names', () => {
  it('does not echo the name in the error, and refuses long or non-string values', async () => {
    const missing = await save(store, 'x', { renameFrom: 'Secret thing' });
    expect(missing).toEqual({ error: 'There is no saved style with that name.' });
    expect(await save(store, 'x', { renameFrom: 'y'.repeat(41) })).toMatchObject({ error: expect.any(String) });
    expect(await save(store, 'x', { renameFrom: 5 as unknown as string })).toMatchObject({ error: expect.any(String) });
    expect(await deleteStyle(store, 'u1', 'y'.repeat(41))).toBe(false);
    expect(await deleteStyle(store, 'u1', 5 as unknown as string)).toBe(false);
  });
});

describe('concurrent default switches', () => {
  it('leave exactly one default, and it names an existing style', async () => {
    const racing = new YieldingStore();
    await save(racing, 'One');
    await save(racing, 'Two');
    await Promise.all([save(racing, 'One', { makeDefault: true }), save(racing, 'Two', { makeDefault: true })]);
    const styles = await listStyles(racing, 'u1');
    expect(styles.filter(s => s.isDefault)).toHaveLength(1);
    expect(await getDefaultStyle(racing, 'u1')).toBeDefined();
  });
});

describe('isolation between people', () => {
  it('hides styles, defaults and deletes from another user', async () => {
    await save(store, 'Mine', { makeDefault: true });
    expect(await listStyles(store, 'u2')).toEqual([]);
    expect(await getDefaultStyle(store, 'u2')).toBeUndefined();
    expect(await deleteStyle(store, 'u2', 'Mine')).toBe(false);
    await save(store, 'Mine', { user: 'u2' });
    expect((await listStyles(store, 'u1'))[0]).toMatchObject({ name: 'Mine', isDefault: true });
    expect((await listStyles(store, 'u2'))[0]).toMatchObject({ name: 'Mine', isDefault: false });
  });
});
