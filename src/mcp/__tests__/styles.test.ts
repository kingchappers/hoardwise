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
    ['501-character description', 'Name', 'x'.repeat(501)],
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
    expect(check('x'.repeat(40), 'y'.repeat(500)).ok).toBe(true);
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
    expect(await save(store, 'x', { renameFrom: 'Nope' })).toMatchObject({ error: expect.stringContaining('Nope') });
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
}

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
