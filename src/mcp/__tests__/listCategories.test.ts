import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES } from '../../api/defaults';
import { catSk, pk, potSk } from '../../api/db';
import { setStore } from '../../store';
import { MemoryStore } from '../../store/memory';
import { MCP_TOOLS } from '../tools';
import { PRIVACY_NOTE } from '../tools/shared';
import type { McpTool } from '../types';

const NOW = new Date('2026-11-01T12:00:00.000Z');
let store: MemoryStore;

function tool(): McpTool {
  const found = MCP_TOOLS.find(t => t.name === 'list_categories');
  if (!found) throw new Error('no list_categories tool');
  return found;
}

async function list(userId = 'user-a'): Promise<{ note: string; categories: Array<Record<string, unknown>> }> {
  const outcome = await tool().run({}, { userId, scope: 'read', now: NOW });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.data as { note: string; categories: Array<Record<string, unknown>> };
}

async function addCategory(userId: string, categoryId: string, name: string, type: string, group?: string): Promise<void> {
  await store.put({ PK: pk(userId), SK: catSk(categoryId), categoryId, name, type, icon: 'default', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z', ...(group ? { group } : {}) });
}

beforeEach(() => {
  store = new MemoryStore();
  setStore(store);
});

describe('list_categories', () => {
  it('is a read-only tool with no input', () => {
    expect(tool().access).toBe('read');
    expect(tool().annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool().inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('lists the defaults with the note, naming each kind and group', async () => {
    const result = await list();
    expect(result.note).toBe(PRIVACY_NOTE);
    expect(result.categories).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(result.categories).toContainEqual({ categoryId: 'cat-groceries', name: 'Groceries', kind: 'spend', group: 'EVERYDAY' });
    expect(result.categories).toContainEqual({ categoryId: 'cat-holidays', name: 'Holidays', kind: 'pot', group: 'SINKING_FUNDS' });
    expect(result.categories.find(c => c.kind === 'income')?.group).toBeNull();
  });

  it('includes the person\'s own categories and labels income, spend and pot', async () => {
    await addCategory('user-a', 'c-spend', 'Pet food', 'EXPENSE', 'EVERYDAY');
    await addCategory('user-a', 'c-inc', 'Side job', 'INCOME');
    await addCategory('user-a', 'c-pot', 'Bike fund', 'POT', 'SINKING_FUNDS');
    const byId = Object.fromEntries((await list()).categories.map(c => [c.categoryId, c]));
    expect(byId['c-spend']).toEqual({ categoryId: 'c-spend', name: 'Pet food', kind: 'spend', group: 'EVERYDAY' });
    expect(byId['c-inc']).toEqual({ categoryId: 'c-inc', name: 'Side job', kind: 'income', group: null });
    expect(byId['c-pot']).toEqual({ categoryId: 'c-pot', name: 'Bike fund', kind: 'pot', group: 'SINKING_FUNDS' });
  });

  it('omits archived categories', async () => {
    await addCategory('user-a', 'c-pot', 'Bike fund', 'POT', 'SINKING_FUNDS');
    await store.put({ PK: pk('user-a'), SK: potSk('c-pot'), categoryId: 'c-pot', archivedAt: '2026-10-01T00:00:00.000Z' });
    const ids = (await list()).categories.map(c => c.categoryId);
    expect(ids).not.toContain('c-pot');
    expect(ids).toContain('cat-holidays');
  });

  it('clips long names', async () => {
    await addCategory('user-a', 'c-long', 'x'.repeat(500), 'EXPENSE');
    const found = (await list()).categories.find(c => c.categoryId === 'c-long');
    expect((found?.name as string).length).toBe(200);
  });

  it('does not show another person\'s categories', async () => {
    await addCategory('user-b', 'c-b', 'Private', 'EXPENSE');
    expect((await list('user-a')).categories.map(c => c.categoryId)).not.toContain('c-b');
  });
});
