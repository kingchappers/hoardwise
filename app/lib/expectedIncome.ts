import { monthHasData, regularAmount } from '../../src/mcp/calc';
import type { Transaction } from './types';

export function regularIncomeFromHistory(transactions: Transaction[], month: string): number | null {
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
  return regularAmount(incomeByMonth, month, monthsWithData);
}
