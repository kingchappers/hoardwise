import { describe, expect, it } from 'vitest';
import type { TokenScope } from '../../auth/tokens';
import { toolAllowed } from '../types';
import type { ToolAccess } from '../types';

// The deny-by-default gate: a tool is registered for a connection only when this says yes.
describe('toolAllowed', () => {
  it.each<[TokenScope, ToolAccess, boolean]>([
    ['read', 'read', true],
    ['read', 'styles', true],
    ['read', 'budget', false],
    ['write', 'read', true],
    ['write', 'styles', true],
    ['write', 'budget', true],
  ])('%s scope, %s access: %s', (scope, access, allowed) => {
    expect(toolAllowed(scope, access)).toBe(allowed);
  });

  it.each([
    ['admin', 'read'],
    ['', 'styles'],
    ['read', 'admin'],
    ['write', 'admin'],
    ['write', ''],
  ])('denies scope %j with access %j', (scope, access) => {
    expect(toolAllowed(scope as TokenScope, access as ToolAccess)).toBe(false);
  });
});
