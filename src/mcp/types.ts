import type { TokenScope } from '../auth/tokens';

export const MCP_MAX_BODY_BYTES = 65_536;
export const MCP_MAX_RESULT_CHARS = 200_000;

export type ToolAccess = 'read' | 'styles' | 'budget';

export interface McpContext {
  userId: string;
  scope: TokenScope;
  now: Date;
}

export type ToolOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; message: string };

export interface McpTool {
  name: string;
  title: string;
  description: string;
  access: ToolAccess;
  // JSON Schema advertised in tools/list. The tool checks its own arguments in run, so its messages stay its own.
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: false;
  };
  run(args: Record<string, unknown>, context: McpContext): Promise<ToolOutcome>;
}

export function toolAllowed(scope: TokenScope, access: ToolAccess): boolean {
  if (scope === 'write') return true;
  return access === 'read' || access === 'styles';
}
