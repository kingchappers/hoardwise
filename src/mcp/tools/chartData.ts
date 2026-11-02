import type { PotSummary } from '../../api/types';
import { outgoingsParts } from '../../shared/monthFigures';
import { loadBudget, loadBudgetWithHistory, shiftMonth, type Budget } from '../data';
import { buildMonthReview, type MonthReview } from '../review';
import type { McpTool } from '../types';
import { PRIVACY_NOTE, READ_ONLY, clip, monthIsTooFarAhead, monthOf, potsFor, readMonth } from './shared';

const VIEWS = ['month-summary', 'category-share', 'monthly-trend', 'category-vs-target'] as const;
type View = (typeof VIEWS)[number];
interface Point {
  label: string;
  value: number;
}

const DEFAULT_MONTHS = 6;
const MAX_MONTHS = 12;
// Points in the chart, in total: more categories than this are grouped.
const MAX_POINTS = 8;
// Months before the month, so the review has the same history as month_review.
const REVIEW_LOOKBACK = 6;

function pounds(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

function nothingLogged(month: string): { series: Point[]; summary: string } {
  return { series: [], summary: `Nothing is logged yet for ${month}.` };
}

function totalSentence(spentAndPutAway: number, income: number): string {
  const gap = Math.abs(income - spentAndPutAway);
  if (spentAndPutAway > income) return `which is ${pounds(gap)} more than your income`;
  if (spentAndPutAway < income) return `which is ${pounds(gap)} less than your income`;
  return 'which matches your income';
}

function monthSummary(review: MonthReview): { series: Point[]; summary: string } {
  if (review.dataLevel === 'none') return nothingLogged(review.month);
  const { income, spentAndPutAway, actuallySpent } = review.figures;
  const parts = outgoingsParts(review.figures);
  return {
    series: [
      { label: 'Income', value: income },
      { label: 'Expenses', value: parts.expenses },
      { label: 'Put into pots', value: parts.putIntoPots },
      { label: 'Spent + put away', value: spentAndPutAway },
      { label: 'Actually spent', value: actuallySpent },
    ],
    summary: `In ${review.month} you have logged ${pounds(income)} of income. You spent ${pounds(actuallySpent)} and, counting ${pounds(parts.putIntoPots)} put into pots, ${pounds(spentAndPutAway)} in total, ${totalSentence(spentAndPutAway, income)}.`,
  };
}

function categoryShare(review: MonthReview): { series: Point[]; summary: string } {
  const spending = review.categories
    .filter((c) => c.type !== 'INCOME' && c.thisMonth > 0)
    .sort((a, b) => b.thisMonth - a.thisMonth);
  if (spending.length === 0) return nothingLogged(review.month);
  const grouped = spending.length > MAX_POINTS;
  const named = grouped ? spending.slice(0, MAX_POINTS - 1) : spending;
  const series: Point[] = named.map((c) => ({ label: clip(c.name), value: c.thisMonth }));
  if (grouped) {
    series.push({ label: 'Everything else', value: spending.slice(MAX_POINTS - 1).reduce((sum, c) => sum + c.thisMonth, 0) });
  }
  const total = spending.reduce((sum, c) => sum + c.thisMonth, 0);
  return {
    series,
    // No name here: names are the person's own text, so they stay in the labels.
    summary: `In ${review.month} the largest category took ${pounds(series[0].value)} of ${pounds(total)} spent.`,
  };
}

function categoryVsTarget(review: MonthReview): { series: Point[]; summary: string } {
  if (review.dataLevel === 'none') return nothingLogged(review.month);
  const withTarget = review.categories.filter((c) => c.type === 'EXPENSE' && c.target !== null);
  if (withTarget.length === 0) {
    return { series: [], summary: `No targets are set for ${review.month}, so there is nothing to compare yet.` };
  }
  const series = withTarget.flatMap((c) => [
    { label: `${clip(c.name)} spent`, value: c.thisMonth },
    { label: `${clip(c.name)} target`, value: c.target ?? 0 },
  ]);
  const over = withTarget.filter((c) => c.overTarget).length;
  const summary =
    over === 0
      ? `In ${review.month}, ${withTarget.length} categories with a target are all within it so far.`
      : `In ${review.month}, ${over} of ${withTarget.length} categories with a target went over it.`;
  return { series, summary };
}

async function withPotHistory(
  userId: string,
  range: { from: string; to: string },
  month: string,
): Promise<{ budget: Budget; pots: PotSummary[] }> {
  const budget = await loadBudgetWithHistory(userId, range);
  return { budget, pots: potsFor(budget, month) };
}

export const chartDataTool: McpTool = {
  name: 'chart_data',
  title: 'Chart data',
  description:
    'Gives figures ready to draw as a chart, with a plain sentence describing them: a month summary (income, expenses, money put into pots, spent plus put away, and what was actually spent), spending by category, a monthly spending trend, or categories against their targets. Amounts are in pence (integers). Never includes individual transactions. Read-only.',
  access: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      view: { type: 'string', enum: [...VIEWS], description: 'Which chart.' },
      month: { type: 'string', description: 'Month as YYYY-MM. Defaults to the current month.' },
      months: { type: 'integer', minimum: 1, maximum: MAX_MONTHS, description: 'For monthly-trend only: how many months, ending at month. Default 6.' },
    },
    required: ['view'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, context) {
    const view = VIEWS.find((v) => v === args.view);
    if (!view) return { ok: false, message: `view must be one of ${VIEWS.join(', ')}` };
    const parsed = readMonth(args.month);
    if (!parsed.ok) return parsed;
    const months = args.months === undefined ? DEFAULT_MONTHS : args.months;
    if (typeof months !== 'number' || !Number.isInteger(months) || months < 1 || months > MAX_MONTHS) {
      return { ok: false, message: `months must be a whole number from 1 to ${MAX_MONTHS}` };
    }
    const month = parsed.month ?? monthOf(context.now);
    if (monthIsTooFarAhead(month, context.now)) {
      return { ok: false, message: 'month must be at most one month ahead' };
    }

    const range = { from: shiftMonth(month, -Math.max(REVIEW_LOOKBACK, months - 1)), to: month };
    // Only the month summary draws pots, so only it reads the full history that pot balances need.
    const { budget, pots } =
      view === 'month-summary'
        ? await withPotHistory(context.userId, range, month)
        : { budget: await loadBudget(context.userId, range), pots: [] };
    const review = buildMonthReview({
      month,
      now: context.now,
      categories: budget.categories,
      transactions: budget.transactions,
      targets: budget.targets,
      pots,
    });

    const built = buildView(view, review, budget.transactions, month, months);
    return {
      ok: true,
      data: { note: PRIVACY_NOTE, view, unit: 'pence', series: built.series, accessibleSummary: built.summary },
    };
  },
};

function buildView(
  view: View,
  review: MonthReview,
  transactions: { yearMonth: string; type: string; amount: number }[],
  month: string,
  months: number,
): { series: Point[]; summary: string } {
  if (view === 'month-summary') return monthSummary(review);
  if (view === 'category-share') return categoryShare(review);
  if (view === 'category-vs-target') return categoryVsTarget(review);
  return monthlyTrend(transactions, month, months);
}

function monthlyTrend(
  transactions: { yearMonth: string; type: string; amount: number }[],
  month: string,
  months: number,
): { series: Point[]; summary: string } {
  const labels = Array.from({ length: months }, (_, i) => shiftMonth(month, i - (months - 1)));
  const series = labels.map((label) => ({
    label,
    value: transactions.filter((t) => t.yearMonth === label && t.type === 'EXPENSE').reduce((sum, t) => sum + t.amount, 0),
  }));
  // No spending in any month: say so, rather than "highest at £0.00".
  if (series.every((point) => point.value === 0)) return nothingLogged(month);
  const top = series.reduce((a, b) => (b.value > a.value ? b : a));
  return {
    series,
    summary: `Spending over the last ${months} months was highest in ${top.label} at ${pounds(top.value)}.`,
  };
}
