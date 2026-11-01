import { randomUUID } from 'node:crypto';
import { pk, styleSk, STYLE_DEFAULT_SK } from '../api/db';
import { ConditionFailedError, type Item, type Store } from '../store';

export const MAX_STYLES = 20;
export const MAX_STYLE_NAME = 40;
export const MAX_STYLE_DESCRIPTION = 500;

const STYLE_PREFIX = 'STYLE#';
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_FRAGMENTS = ['<', '>', 'http://', 'https://', 'www.', ']('];

export interface GraphicStyle {
  styleId: string;
  name: string;
  description: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type StyleTextResult = { ok: true; name: string; description: string } | { ok: false; message: string };

function checkText(label: string, value: string, max: number): string | undefined {
  if (value === '') return `The ${label} cannot be empty.`;
  if (value.length > max) return `The ${label} must be ${max} characters or fewer.`;
  if (CONTROL_CHARACTERS.test(value)) return `The ${label} must be one line of plain text.`;
  const lower = value.toLowerCase();
  if (FORBIDDEN_FRAGMENTS.some(fragment => lower.includes(fragment))) {
    return `The ${label} cannot contain markup, links or web addresses.`;
  }
  return undefined;
}

export function validateStyleText(input: { name: unknown; description: unknown }): StyleTextResult {
  if (typeof input.name !== 'string') return { ok: false, message: 'The name must be text.' };
  if (typeof input.description !== 'string') return { ok: false, message: 'The description must be text.' };
  const name = input.name.trim();
  const description = input.description.trim();
  const message = checkText('name', name, MAX_STYLE_NAME) ?? checkText('description', description, MAX_STYLE_DESCRIPTION);
  return message ? { ok: false, message } : { ok: true, name, description };
}

function toStyle(item: Item, defaultId: string | undefined): GraphicStyle {
  const styleId = String(item.styleId);
  return {
    styleId,
    name: String(item.name),
    description: String(item.description),
    isDefault: styleId === defaultId,
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

async function readDefaultId(store: Store, userId: string): Promise<string | undefined> {
  const marker = await store.get({ PK: pk(userId), SK: STYLE_DEFAULT_SK });
  return typeof marker?.styleId === 'string' ? marker.styleId : undefined;
}

async function readStyles(store: Store, userId: string): Promise<GraphicStyle[]> {
  const [items, defaultId] = await Promise.all([
    store.query(pk(userId), { skPrefix: STYLE_PREFIX }),
    readDefaultId(store, userId),
  ]);
  return items.map(item => toStyle(item, defaultId));
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export async function listStyles(store: Store, userId: string): Promise<GraphicStyle[]> {
  const styles = await readStyles(store, userId);
  return styles.sort((a, b) =>
    Number(b.isDefault) - Number(a.isDefault)
    || b.updatedAt.localeCompare(a.updatedAt)
    || a.name.localeCompare(b.name));
}

export async function getDefaultStyle(store: Store, userId: string): Promise<GraphicStyle | undefined> {
  return (await readStyles(store, userId)).find(style => style.isDefault);
}

interface SaveInput {
  name: string;
  description: string;
  makeDefault: boolean | undefined;
  renameFrom: string | undefined;
}

export async function saveStyle(
  store: Store,
  userId: string,
  input: SaveInput,
  now: Date,
): Promise<{ style: GraphicStyle; created: boolean } | { error: string }> {
  const text = validateStyleText(input);
  if (!text.ok) return { error: text.message };

  const styles = await readStyles(store, userId);
  const renamed = input.renameFrom === undefined ? undefined : styles.find(s => sameName(s.name, input.renameFrom as string));
  if (input.renameFrom !== undefined && !renamed) return { error: `There is no saved style named "${input.renameFrom.trim()}".` };

  const existing = renamed ?? styles.find(s => sameName(s.name, text.name));
  const clash = styles.find(s => sameName(s.name, text.name));
  if (clash && existing && clash.styleId !== existing.styleId) {
    return { error: 'Another saved style already has that name.' };
  }
  if (!existing && styles.length >= MAX_STYLES) {
    return { error: `You can save at most ${MAX_STYLES} styles. Delete one first.` };
  }

  const iso = now.toISOString();
  const styleId = existing?.styleId ?? randomUUID();
  const createdAt = existing?.createdAt ?? iso;
  await store.put({
    PK: pk(userId), SK: styleSk(styleId), styleId, name: text.name, description: text.description, createdAt, updatedAt: iso,
  });

  let isDefault = existing?.isDefault ?? false;
  if (input.makeDefault === true) {
    await store.put({ PK: pk(userId), SK: STYLE_DEFAULT_SK, styleId });
    isDefault = true;
  } else if (input.makeDefault === false && isDefault) {
    await store.delete({ PK: pk(userId), SK: STYLE_DEFAULT_SK });
    isDefault = false;
  }

  return {
    style: { styleId, name: text.name, description: text.description, isDefault, createdAt, updatedAt: iso },
    created: !existing,
  };
}

export async function deleteStyle(store: Store, userId: string, name: string): Promise<boolean> {
  const styles = await readStyles(store, userId);
  const found = styles.find(s => sameName(s.name, name));
  if (!found) return false;

  const key = { PK: pk(userId), SK: styleSk(found.styleId) };
  try {
    if (found.isDefault) {
      await store.transact([{ delete: key, ifPresent: true }, { delete: { PK: pk(userId), SK: STYLE_DEFAULT_SK } }]);
    } else {
      await store.delete(key, { ifPresent: true });
    }
  } catch (error) {
    if (error instanceof ConditionFailedError) return false;
    throw error;
  }
  return true;
}
