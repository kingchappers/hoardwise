import { monthHasData, monthlyTarget, sumToDay, throughDay, usualFor } from '../calc';
import { loadBudget, shiftMonth } from '../data';
import type { McpTool } from '../types';
import { PRIVACY_NOTE, READ_ONLY, clip, monthOf, readMonth } from './shared';

const DEFAULT_MONTHS = 6;
const MAX_MONTHS = 12;
const MAX_ITEMS = 50;
// Months before the window, so "usual" has the same history as in the review.
const USUAL_LOOKBACK = 6;

export const categoryDetailTool: McpTool = {
  name: 'category_detail',
  title: 'Category detail',
  description:
    "Shows one category: this month's items newest first (up to 50), a total for each recent month (this month so far while it is in progress), what is usual up to the same day, and the target. Amounts are in pence (integers). Read-only.",
  access: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      categoryId: { type: 'string', description: 'The category id, as returned by month_review.' },
      month: { type: 'string', description: 'Month as YYYY-MM. Defaults to the current month.' },
      months: { type: 'integer', minimum: 1, maximum: MAX_MONTHS, description: 'How many months of totals, ending at month. Default 6.' },
    },
    required: ['categoryId'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, context) {
    if (typeof args.categoryId !== 'string' || args.categoryId === '') {
      return { ok: false, message: 'categoryId is required' };
    }
    const parsed = readMonth(args.month);
    if (!parsed.ok) return parsed;
    const months = args.months === undefined ? DEFAULT_MONTHS : args.months;
    if (typeof months !== 'number' || !Number.isInteger(months) || months < 1 || months > MAX_MONTHS) {
      return { ok: false, message: `months must be a whole number from 1 to ${MAX_MONTHS}` };
    }
    const month = parsed.month ?? monthOf(context.now);

    const budget = await loadBudget(context.userId, {
      from: shiftMonth(month, -(months - 1 + USUAL_LOOKBACK)),
      to: month,
    });
    const category = budget.categories.find((c) => c.categoryId === args.categoryId);
    if (!category) return { ok: false, message: 'Unknown category.' };

    const mine = budget.transactions.filter((t) => t.categoryId === category.categoryId);
    // As in month_review: an income category totals its income, any other its spends (a pot's set-asides are not spending).
    const counted = category.type === 'INCOME' ? 'INCOME' : 'EXPENSE';
    const totalTo = (m: string, toDay: number | null): number =>
      sumToDay(mine.filter((t) => t.yearMonth === m && t.type === counted), toDay);
    // A month in progress is set against earlier months up to the same day (review.md, step 7).
    const day = throughDay(month, context.now);
    const items = mine
      .filter((t) => t.yearMonth === month)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

    // A month counts for "usual" when the person logged on enough days, in any category.
    const allMonths = new Set(budget.transactions.map((t) => t.yearMonth));
    const dataMonths = new Set([...allMonths].filter((m) => m < month && monthHasData(budget.transactions.filter((t) => t.yearMonth === m), m)));
    const usual = usualFor(new Map([...dataMonths].map((m) => [m, totalTo(m, day)])), month, dataMonths);

    const target = budget.targets.find((t) => t.categoryId === category.categoryId);
    return {
      ok: true,
      data: {
        note: PRIVACY_NOTE,
        categoryId: category.categoryId,
        name: clip(category.name),
        type: category.type,
        month,
        inProgress: day !== null,
        throughDay: day,
        unit: 'pence',
        itemCount: items.length,
        items: items.slice(0, MAX_ITEMS).map((t) => ({ date: t.date, type: t.type, amount: t.amount, text: clip(t.description) })),
        monthlyTotals: Array.from({ length: months }, (_, i) => shiftMonth(month, i - (months - 1))).map((m) => ({
          month: m,
          total: totalTo(m, m === month ? day : null),
        })),
        usual,
        target: target ? monthlyTarget(target, month) : null,
      },
    };
  },
};
