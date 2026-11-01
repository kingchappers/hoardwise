// Reads one person's budget for the MCP tools. The same reads as the app's API, scoped to userId.
import { DEFAULT_CATEGORIES } from '../api/defaults';
import { queryAll, toSettings } from '../api/pots';
import { toTransaction } from '../api/transactions';
import type { Category, CategoryTarget, PotSettings, Transaction } from '../api/types';

// The same cap as GET /api/transactions/range.
const MAX_SPAN_MONTHS = 24;

export interface Budget {
  categories: Category[];
  transactions: Transaction[];
  targets: CategoryTarget[];
  settings: PotSettings[];
}

export interface BudgetWithHistory extends Budget {
  // Every transaction, for running balances such as pots.
  history: Transaction[];
}

function monthIndex(yearMonth: string): number {
  const [year, month] = yearMonth.split('-').map(Number);
  return year * 12 + (month - 1);
}

export function shiftMonth(yearMonth: string, by: number): string {
  const index = monthIndex(yearMonth) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function toTarget(item: Record<string, unknown>): CategoryTarget {
  return {
    categoryId: item.categoryId as string,
    targetAmount: item.targetAmount as number,
    period: item.period as CategoryTarget['period'],
    updatedAt: item.updatedAt as string,
  };
}

function checkSpan(months: { from: string; to: string }): void {
  if (monthIndex(months.to) - monthIndex(months.from) + 1 > MAX_SPAN_MONTHS) {
    throw new RangeError(`the range must be at most ${MAX_SPAN_MONTHS} months`);
  }
}

async function loadSettings(userId: string): Promise<Omit<Budget, 'transactions'>> {
  const [customCategories, targetItems, settingsItems] = await Promise.all([
    queryAll(userId, 'CAT#'),
    queryAll(userId, 'TARGET#'),
    queryAll(userId, 'POT#'),
  ]);
  return {
    categories: [...DEFAULT_CATEGORIES, ...(customCategories as unknown as Category[])],
    targets: targetItems.map(toTarget),
    settings: settingsItems.map(toSettings),
  };
}

// Only the months asked for: one query per month on the TXN#<yyyy-mm># sort key, at most 24.
export async function loadBudget(userId: string, months: { from: string; to: string }): Promise<Budget> {
  checkSpan(months);
  const count = monthIndex(months.to) - monthIndex(months.from) + 1;
  const keys = Array.from({ length: Math.max(count, 0) }, (_, i) => shiftMonth(months.from, i));
  const [settings, perMonth] = await Promise.all([
    loadSettings(userId),
    Promise.all(keys.map((m) => queryAll(userId, `TXN#${m}#`))),
  ]);
  return { ...settings, transactions: perMonth.flat().map(toTransaction) };
}

// Every transaction, as GET /api/pots reads them: only for tools that show pot balances.
export async function loadBudgetWithHistory(
  userId: string,
  months: { from: string; to: string },
): Promise<BudgetWithHistory> {
  checkSpan(months);
  const [settings, transactionItems] = await Promise.all([loadSettings(userId), queryAll(userId, 'TXN#')]);
  const history = transactionItems.map(toTransaction);
  return {
    ...settings,
    history,
    transactions: history.filter((t) => t.yearMonth >= months.from && t.yearMonth <= months.to),
  };
}
