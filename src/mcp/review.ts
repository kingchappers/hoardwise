// The month review behind the month_review tool. Rules: plugins/hoardwise/skills/budget/review.md.
import type { Category, CategoryTarget, PotSummary, Transaction } from '../api/types';
import { SPARSE_BELOW, median, monthHasData, monthlyTarget, regularAmount, sumToDay, throughDay, usualFor } from './calc';
import { MAX_TEXT, clip } from './tools/shared';

// review.md gives rules of thumb ("about half again", "a small minimum, such as £5",
// "several times the median item"); these are the values we chose for them.
const ABOVE_USUAL_RATIO = 1.5;
const INCOME_BELOW_RATIO = 0.75;
// Pence. Smaller changes are noise, so they are never flagged.
const MIN_GAP = 500;
const BIG_ITEM_RATIO = 4;
const BIG_ITEM_MIN = 2000;
const MIN_ITEMS_FOR_MEDIAN = 3;
const MAX_NOTABLE = 3;
// review.md: in the first week, say it is early and make few or no claims.
const EARLY_DAYS = 7;

export interface ReviewInput {
  month: string;
  now: Date;
  categories: Category[];
  transactions: Transaction[];
  targets: CategoryTarget[];
  pots: PotSummary[];
}

export interface CategoryLine {
  categoryId: string;
  name: string;
  type: Category['type'];
  thisMonth: number;
  usual: number | null;
  target: number | null;
  overTarget: boolean;
  aboveUsual: boolean;
}

export interface PotLine {
  categoryId: string;
  name: string;
  added: number;
  takenOut: number;
  spent: number;
  balance: number;
}

export interface Notable {
  kind: 'category-above-usual' | 'big-item' | 'income-below-usual';
  categoryId: string;
  amount: number;
  gap: number;
  // The item's dated description for a big-item; empty otherwise.
  text: string;
}

export type DataLevel = 'none' | 'little' | 'ok';

export interface MonthReview {
  month: string;
  inProgress: boolean;
  throughDay: number | null;
  dataLevel: DataLevel;
  income: { logged: number; hasLogged: boolean; usual: number | null; regularAmount: number | null };
  spending: { total: number; usual: number | null };
  categories: CategoryLine[];
  pots: PotLine[];
  notable: Notable[];
  incomeQuestion: { ask: boolean; suggestedAmount: number | null };
}

type Keep = (t: Transaction) => boolean;

const monthOf = (t: Transaction): string => t.date.slice(0, 7);
const dayOf = (t: Transaction): number => Number(t.date.slice(8, 10));

function groupByMonth(transactions: Transaction[]): Map<string, Transaction[]> {
  const byMonth = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const list = byMonth.get(monthOf(t)) ?? [];
    list.push(t);
    byMonth.set(monthOf(t), list);
  }
  return byMonth;
}

function dataLevelFor(current: Transaction[], month: string, day: number | null): DataLevel {
  if (current.length === 0) return 'none';
  if (day === null) return monthHasData(current, month) ? 'ok' : 'little';
  if (day <= EARLY_DAYS) return 'little';
  // A month in progress is judged on the days so far, not the whole month.
  const daysWithEntries = new Set(current.map((t) => t.date)).size;
  return daysWithEntries / day >= SPARSE_BELOW ? 'ok' : 'little';
}

function isAboveUsual(thisMonth: number, usual: number | null): boolean {
  if (usual === null) return false;
  return thisMonth > usual * ABOVE_USUAL_RATIO && thisMonth - usual >= MIN_GAP;
}

function isBelowUsual(thisMonth: number, usual: number | null): boolean {
  if (usual === null) return false;
  return thisMonth < usual * INCOME_BELOW_RATIO && usual - thisMonth >= MIN_GAP;
}

export function buildMonthReview(input: ReviewInput): MonthReview {
  const { month, now, categories, transactions, targets, pots } = input;
  const day = throughDay(month, now);
  const byMonth = groupByMonth(transactions);
  const current = (byMonth.get(month) ?? []).filter((t) => day === null || dayOf(t) <= day);
  // Earlier months are judged as having data on the whole month.
  const dataMonths = new Set(
    [...byMonth.keys()].filter((m) => m < month && monthHasData(byMonth.get(m) ?? [], m)),
  );

  // This month so far, and each earlier month up to the same day (the whole month when day is null).
  const earlierSums = (keep: Keep, toDay: number | null): Map<string, number> =>
    new Map([...dataMonths].map((m) => [m, sumToDay((byMonth.get(m) ?? []).filter(keep), toDay)]));
  const compare = (keep: Keep): { thisMonth: number; usual: number | null } => ({
    thisMonth: sumToDay(current.filter(keep), null),
    usual: usualFor(earlierSums(keep, day), month, dataMonths),
  });

  const isIncome: Keep = (t) => t.type === 'INCOME';
  const income = compare(isIncome);
  const spending = compare((t) => t.type === 'EXPENSE');
  // review.md: a month with any INCOME entry uses what is logged, so a payday dated
  // after today counts as logged even though it is not in the total so far.
  const wholeMonth = byMonth.get(month) ?? [];
  const hasLogged = wholeMonth.some(isIncome);
  // Not paid yet is not below usual, so these categories are never flagged as such.
  const paidLater = new Set(
    wholeMonth.filter((t) => isIncome(t) && day !== null && dayOf(t) > day).map((t) => t.categoryId),
  );
  // The income question is about the whole month, so the regular amount uses whole earlier months.
  const regular = regularAmount(earlierSums(isIncome, null), month, dataMonths);

  const categoryLines = buildCategoryLines(categories, targets, month, compare);
  const dataLevel = dataLevelFor(current, month, day);
  const notable =
    dataLevel === 'ok' ? pickNotable(categoryLines, current, byMonth, dataMonths, paidLater) : [];

  return {
    month,
    inProgress: day !== null,
    throughDay: day,
    dataLevel,
    income: { logged: income.thisMonth, hasLogged, usual: income.usual, regularAmount: regular },
    spending: { total: spending.thisMonth, usual: spending.usual },
    categories: categoryLines,
    pots: buildPotLines(pots, categories),
    notable,
    incomeQuestion: { ask: !hasLogged, suggestedAmount: hasLogged ? null : regular },
  };
}

function buildCategoryLines(
  categories: Category[],
  targets: CategoryTarget[],
  month: string,
  compare: (keep: Keep) => { thisMonth: number; usual: number | null },
): CategoryLine[] {
  const targetById = new Map(targets.map((t) => [t.categoryId, t]));
  const lines: CategoryLine[] = [];
  for (const category of categories) {
    // A pot category's line is its spends, which count in the month's spending.
    const counted = category.type === 'INCOME' ? 'INCOME' : 'EXPENSE';
    const { thisMonth, usual } = compare((t) => t.categoryId === category.categoryId && t.type === counted);
    const listedAlways = category.type !== 'POT' && !category.archived;
    if (!listedAlways && thisMonth === 0) continue;
    // A spend in a pot category is never compared with a target.
    const rawTarget = category.type === 'EXPENSE' ? targetById.get(category.categoryId) : undefined;
    const target = rawTarget ? monthlyTarget(rawTarget, month) : null;
    lines.push({
      categoryId: category.categoryId,
      name: clip(category.name),
      type: category.type,
      thisMonth,
      usual,
      target,
      overTarget: target !== null && thisMonth > target,
      aboveUsual: isAboveUsual(thisMonth, usual),
    });
  }
  return lines;
}

function pickNotable(
  lines: CategoryLine[],
  current: Transaction[],
  byMonth: Map<string, Transaction[]>,
  dataMonths: Set<string>,
  paidLater: Set<string>,
): Notable[] {
  // With no income logged so far, review.md says make no claim that depends on income.
  const incomeSoFar = current.some((t) => t.type === 'INCOME');
  const found: Notable[] = [];
  for (const line of lines) {
    if (line.type !== 'INCOME' && line.aboveUsual && line.usual !== null) {
      found.push({ kind: 'category-above-usual', categoryId: line.categoryId, amount: line.thisMonth, gap: line.thisMonth - line.usual, text: '' });
    }
    const incomeCheck = line.type === 'INCOME' && incomeSoFar && !paidLater.has(line.categoryId);
    if (incomeCheck && isBelowUsual(line.thisMonth, line.usual) && line.usual !== null) {
      found.push({ kind: 'income-below-usual', categoryId: line.categoryId, amount: line.thisMonth, gap: line.usual - line.thisMonth, text: '' });
    }
  }
  found.push(...bigItems(current, byMonth, dataMonths));
  return found.sort((a, b) => b.gap - a.gap).slice(0, MAX_NOTABLE);
}

// Item sizes are not skewed by a part month, so the median item uses whole earlier months.
function bigItems(current: Transaction[], byMonth: Map<string, Transaction[]>, dataMonths: Set<string>): Notable[] {
  const earlier = [...dataMonths].flatMap((m) => byMonth.get(m) ?? []).filter((t) => t.type === 'EXPENSE');
  const medianItem = new Map<string, number | null>();
  const medianFor = (categoryId: string): number | null => {
    if (!medianItem.has(categoryId)) {
      const items = earlier.filter((t) => t.categoryId === categoryId).map((t) => t.amount);
      medianItem.set(categoryId, items.length >= MIN_ITEMS_FOR_MEDIAN ? median(items) : null);
    }
    return medianItem.get(categoryId) ?? null;
  };

  const found: Notable[] = [];
  for (const t of current) {
    if (t.type !== 'EXPENSE') continue;
    const usualItem = medianFor(t.categoryId);
    if (usualItem === null) continue;
    if (t.amount < usualItem * BIG_ITEM_RATIO || t.amount < BIG_ITEM_MIN) continue;
    found.push({
      kind: 'big-item',
      categoryId: t.categoryId,
      amount: t.amount,
      gap: t.amount - usualItem,
      text: `${t.date}: ${clip(t.description)}`.slice(0, MAX_TEXT),
    });
  }
  return found;
}

function buildPotLines(pots: PotSummary[], categories: Category[]): PotLine[] {
  const nameById = new Map(categories.map((c) => [c.categoryId, c.name]));
  return pots
    .filter((p) => !p.archivedAt)
    .map((p) => ({
      categoryId: p.categoryId,
      name: clip(nameById.get(p.categoryId)),
      added: p.thisMonth.setAside + p.thisMonth.autoAdded,
      takenOut: p.thisMonth.takeOut,
      spent: p.thisMonth.spent,
      balance: p.balance,
    }))
    .filter((p) => p.added !== 0 || p.takenOut !== 0 || p.spent !== 0);
}
