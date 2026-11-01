import { getStore } from '../../store';
import { deleteStyle, getDefaultStyle, listStyles, MAX_STYLE_DESCRIPTION, MAX_STYLES, NOT_FOUND, saveStyle } from '../styles';
import type { McpTool, ToolOutcome } from '../types';
import { PRIVACY_NOTE, READ_ONLY, UNKNOWN_FIELD, WRITES_OWN_DATA, clip } from './shared';

// A fixed message, so an unvalidated key is never echoed back.
function unknownField(args: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(args).some(key => !allowed.includes(key)) ? UNKNOWN_FIELD : undefined;
}

const nameProperty = { type: 'string', description: 'The style name, at most 40 characters of plain text.' };

export const listStylesTool: McpTool = {
  name: 'list_styles',
  title: 'List saved styles',
  description:
    'Lists the graphic styles the person has saved, with the default first. Use it when they ask "what styles have I saved?". Each style is a name and a short plain-text description of a look. Read-only.',
  access: 'styles',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: READ_ONLY,
  async run(_args, context): Promise<ToolOutcome> {
    const styles = await listStyles(getStore(), context.userId);
    return {
      ok: true,
      data: {
        note: PRIVACY_NOTE,
        styles: styles.map(s => ({ name: clip(s.name), description: clip(s.description), isDefault: s.isDefault })),
        limit: MAX_STYLES,
      },
    };
  },
};

export const saveStyleTool: McpTool = {
  name: 'save_style',
  title: 'Save a style',
  description:
    'Saves a graphic style by name, or updates one with the same name. Save only when the person asks or agrees, for example "save this as \'big number\'", and confirm the name back to them. A style is only a name and a short plain-text description of the look: no images, no data, no links. "Always show me that one" means makeDefault true; makeDefault false clears the default if it is this style. Use renameFrom to rename an existing style. If a style with that name already exists (check with list_styles, or created: false in the result) this replaces it, so confirm with the person before replacing it.',
  access: 'styles',
  inputSchema: {
    type: 'object',
    properties: {
      name: nameProperty,
      description: { type: 'string', maxLength: MAX_STYLE_DESCRIPTION, description: `A short plain-text description of the look, at most ${MAX_STYLE_DESCRIPTION} characters.` },
      makeDefault: { type: 'boolean', description: 'True to make this the default style; false to clear the default if it is this style.' },
      renameFrom: { type: 'string', description: 'The name of an existing style to rename to name.' },
    },
    required: ['name', 'description'],
    additionalProperties: false,
  },
  annotations: { ...WRITES_OWN_DATA, destructiveHint: true },
  async run(args, context): Promise<ToolOutcome> {
    const unknown = unknownField(args, ['name', 'description', 'makeDefault', 'renameFrom']);
    if (unknown) return { ok: false, message: unknown };
    if (typeof args.name !== 'string') return { ok: false, message: 'name must be text' };
    if (typeof args.description !== 'string') return { ok: false, message: 'description must be text' };
    if (args.makeDefault !== undefined && typeof args.makeDefault !== 'boolean') {
      return { ok: false, message: 'makeDefault must be true or false' };
    }
    if (args.renameFrom !== undefined && typeof args.renameFrom !== 'string') {
      return { ok: false, message: 'renameFrom must be text' };
    }

    const result = await saveStyle(
      getStore(),
      context.userId,
      { name: args.name, description: args.description, makeDefault: args.makeDefault, renameFrom: args.renameFrom },
      context.now,
    );
    if ('error' in result) return { ok: false, message: result.error };
    const { style, created } = result;
    return {
      ok: true,
      data: {
        note: PRIVACY_NOTE,
        style: { name: clip(style.name), description: clip(style.description), isDefault: style.isDefault },
        created,
      },
    };
  },
};

export const deleteStyleTool: McpTool = {
  name: 'delete_style',
  title: 'Delete a style',
  description: 'Deletes one saved style by name. Use it only when the person asks to remove that style.',
  access: 'styles',
  inputSchema: { type: 'object', properties: { name: nameProperty }, required: ['name'], additionalProperties: false },
  annotations: { ...WRITES_OWN_DATA, destructiveHint: true },
  async run(args, context): Promise<ToolOutcome> {
    const unknown = unknownField(args, ['name']);
    if (unknown) return { ok: false, message: unknown };
    if (typeof args.name !== 'string') return { ok: false, message: 'name must be text' };
    const deleted = await deleteStyle(getStore(), context.userId, args.name);
    return deleted ? { ok: true, data: { deleted: true } } : { ok: false, message: NOT_FOUND };
  },
};

export async function defaultStyleFor(userId: string): Promise<{ name: string; description: string } | null> {
  const style = await getDefaultStyle(getStore(), userId);
  return style ? { name: clip(style.name), description: clip(style.description) } : null;
}
