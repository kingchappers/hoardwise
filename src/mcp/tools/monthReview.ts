import { loadBudgetWithHistory, shiftMonth } from '../data';
import { buildMonthReview, type MonthReview } from '../review';
import type { McpTool } from '../types';
import { PRIVACY_NOTE, READ_ONLY, monthIsTooFarAhead, monthOf, potsFor, readMonth } from './shared';

// The month and the six before it.
const MONTHS_BACK = 6;

const INCOME_QUESTION = 'How much do you expect to have coming in this month?';

// Whole pounds with thousands separators, as review.md writes it: "about £2,300".
function roughPounds(pence: number): string {
  return `£${Math.round(pence / 100).toLocaleString('en-GB')}`;
}

// review.md, Income: with nothing logged, the review comes first and the one question is the income question.
function incomeRules(review: MonthReview): string[] {
  const { incomeQuestion, income } = review;
  if (incomeQuestion.ask) {
    const usual = incomeQuestion.suggestedAmount === null ? '' : ` You usually have about ${roughPounds(incomeQuestion.suggestedAmount)}.`;
    return [
      'No income is logged for this month. Give the review first, with what is known, and make no claim that depends on income: no savings estimate and no "doing well overall".',
      `End with one question: "${INCOME_QUESTION}${usual}"`,
      'Leave out the offer of more detail until they answer, so there is one question at a time.',
    ];
  }
  if (income.hasLogged && income.logged === 0) {
    return ['Income is logged for later this month, so make no income claim yet.'];
  }
  return [];
}

function guidanceFor(review: MonthReview): string[] {
  const rules = [
    'Lead with how things are going, in plain, calm words.',
    review.incomeQuestion.ask
      ? 'Mention at most three points.'
      : 'Mention at most three points, then offer more detail instead of showing it all.',
  ];
  if (review.inProgress) rules.push('This month is still in progress: say "so far" and compare like for like.');
  if (review.dataLevel !== 'ok') rules.push('There is little data yet: say it is early and make few or no claims.');
  rules.push(...incomeRules(review));
  rules.push('Use neutral wording such as "went over"; never blame.');
  return rules;
}

export const monthReviewTool: McpTool = {
  name: 'month_review',
  title: 'Month review',
  description:
    "Summarises how a month is going: income, spending against what is usual and any targets, pots, and anything worth mentioning. Defaults to the current month. Amounts are in pence (integers). Read-only.",
  access: 'read',
  inputSchema: {
    type: 'object',
    properties: { month: { type: 'string', description: 'Month as YYYY-MM. Defaults to the current month.' } },
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

    const budget = await loadBudgetWithHistory(context.userId, { from: shiftMonth(month, -MONTHS_BACK), to: month });
    const review = buildMonthReview({
      month,
      now: context.now,
      categories: budget.categories,
      transactions: budget.transactions,
      targets: budget.targets,
      pots: potsFor(budget, month),
    });
    return { ok: true, data: { note: PRIVACY_NOTE, unit: 'pence', ...review, guidance: guidanceFor(review) } };
  },
};
