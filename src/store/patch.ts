const KEY_ATTRIBUTES = new Set(['PK', 'SK']);

export interface PatchPlan {
  fields: [string, unknown][];
  defaults: [string, unknown][];
}

function definedEntries(values: Record<string, unknown>): [string, unknown][] {
  return Object.entries(values).filter(([, value]) => value !== undefined);
}

export function matchesAll(current: Record<string, unknown> | undefined, expected: Record<string, unknown> | undefined): boolean {
  if (expected === undefined) return true;
  if (current === undefined) return false;
  return Object.entries(expected).every(([name, value]) => current[name] === value);
}

export function planPatch(fields: Record<string, unknown>, defaults: Record<string, unknown> = {}): PatchPlan {
  const plan: PatchPlan = { fields: definedEntries(fields), defaults: definedEntries(defaults) };
  if (plan.fields.length + plan.defaults.length === 0) {
    throw new Error('patch needs at least one field');
  }

  const keyAttribute = [...plan.fields, ...plan.defaults].find(([name]) => KEY_ATTRIBUTES.has(name));
  if (keyAttribute) {
    throw new Error(`patch cannot change the key attribute "${keyAttribute[0]}"`);
  }

  const fieldNames = new Set(plan.fields.map(([name]) => name));
  const overlap = plan.defaults.find(([name]) => fieldNames.has(name));
  if (overlap) {
    throw new Error(`patch attribute "${overlap[0]}" is in both fields and defaults`);
  }
  return plan;
}
