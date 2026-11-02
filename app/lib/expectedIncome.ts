import { monthHasData, regularAmount } from '../../src/mcp/calc';
import type { Transaction } from './types';

export type RegularIncomeReason = 'ok' | 'too-few-months' | 'varies';

const MIN_MONTHS = 3;

export function regularIncomeFromHistory(transactions: Transaction[], month: string): number | null {
  return regularIncomeStatus(transactions, month).amount;
}

export function regularIncomeStatus(
  transactions: Transaction[],
  month: string,
): { amount: number | null; reason: RegularIncomeReason } {
  const byMonth = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const key = t.date.slice(0, 7);
    if (key >= month) continue;
    byMonth.set(key, [...(byMonth.get(key) ?? []), t]);
  }

  const incomeByMonth = new Map<string, number>();
  const monthsWithData = new Set<string>();
  for (const [key, rows] of byMonth) {
    const total = rows.filter((t) => t.type === 'INCOME').reduce((sum, t) => sum + t.amount, 0);
    incomeByMonth.set(key, total);
    if (monthHasData(rows, key)) monthsWithData.add(key);
  }
  const amount = regularAmount(incomeByMonth, month, monthsWithData);
  if (amount !== null) return { amount, reason: 'ok' };
  const monthsWithIncome = [...monthsWithData].filter((key) => (incomeByMonth.get(key) ?? 0) > 0);
  return { amount: null, reason: monthsWithIncome.length < MIN_MONTHS ? 'too-few-months' : 'varies' };
}
