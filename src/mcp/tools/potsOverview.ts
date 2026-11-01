import { loadBudgetWithHistory } from '../data';
import type { McpTool } from '../types';
import { PRIVACY_NOTE, READ_ONLY, clip, monthIsTooFarAhead, monthOf, potsFor, readMonth } from './shared';

export const potsOverviewTool: McpTool = {
  name: 'pots_overview',
  title: 'Pots overview',
  description:
    "Lists the active pots: balance, goal, monthly amount, and what was added, taken out and spent in the month. Defaults to the current month. Amounts are in pence (integers). Read-only.",
  access: 'read',
  inputSchema: {
    type: 'object',
    properties: { month: { type: 'string', description: 'Month as YYYY-MM, at most one month ahead. Defaults to the current month.' } },
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, context) {
    const parsed = readMonth(args.month);
    if (!parsed.ok) return parsed;
    const month = parsed.month ?? monthOf(context.now);
    // The same limit as GET /api/pots?asOf.
    if (monthIsTooFarAhead(month, context.now)) {
      return { ok: false, message: 'month must be at most one month ahead' };
    }

    // Balances run from all history, so the month range only has to cover the month itself.
    const budget = await loadBudgetWithHistory(context.userId, { from: month, to: month });
    const nameById = new Map(budget.categories.map((c) => [c.categoryId, c.name]));
    const pots = potsFor(budget, month)
      .filter((p) => !p.archivedAt)
      .map((p) => ({
        categoryId: p.categoryId,
        name: clip(nameById.get(p.categoryId)),
        balance: p.balance,
        goal: p.goalAmount,
        monthly: p.monthlyAmount,
        added: p.thisMonth.setAside + p.thisMonth.autoAdded,
        takenOut: p.thisMonth.takeOut,
        spent: p.thisMonth.spent,
      }));
    return { ok: true, data: { note: PRIVACY_NOTE, month, unit: 'pence', pots } };
  },
};
