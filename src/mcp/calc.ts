// Mirrors the app: app/lib/summary.ts (daysInMonth, normaliseTargetToMonth)
// and app/lib/insights.ts (SPARSE_BELOW). Rules: plugins/hoardwise/skills/budget/review.md.
export const SPARSE_BELOW = 0.25;
const MAX_USUAL_MONTHS = 6;
const MIN_USUAL_MONTHS = 3;
// Regular income varies by at most 1/20 (5%) of its median, compared in whole numbers.
const REGULAR_SPREAD_PARTS = 20;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function daysInMonth(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

export function monthHasData(transactions: { date: string }[], month: string): boolean {
  const days = new Set(transactions.filter((t) => t.date.startsWith(`${month}-`)).map((t) => t.date));
  return days.size / daysInMonth(month) >= SPARSE_BELOW;
}

function priorMonthValues(
  valuesByMonth: Map<string, number>,
  month: string,
  monthsWithData: Set<string>,
): number[] {
  return [...monthsWithData]
    .filter((m) => m < month)
    .sort()
    .slice(-MAX_USUAL_MONTHS)
    .map((m) => valuesByMonth.get(m) ?? 0);
}

export function usualFor(
  valuesByMonth: Map<string, number>,
  month: string,
  monthsWithData: Set<string>,
): number | null {
  const values = priorMonthValues(valuesByMonth, month, monthsWithData);
  if (values.length < MIN_USUAL_MONTHS) return null;
  return median(values);
}

export function monthlyTarget(
  target: { targetAmount: number; period: 'MONTHLY' | 'WEEKLY' },
  month: string,
): number {
  if (target.period === 'MONTHLY') return target.targetAmount;
  return Math.round((target.targetAmount * daysInMonth(month)) / 7);
}

export function throughDay(month: string, now: Date): number | null {
  if (now.toISOString().slice(0, 7) !== month) return null;
  return now.getUTCDate();
}

export function sumToDay(transactions: { date: string; amount: number }[], day: number | null): number {
  return transactions
    .filter((t) => day === null || Number(t.date.slice(8, 10)) <= day)
    .reduce((sum, t) => sum + t.amount, 0);
}

export function regularAmount(
  valuesByMonth: Map<string, number>,
  month: string,
  monthsWithData: Set<string>,
): number | null {
  const withIncome = new Set(
    [...monthsWithData].filter((m) => (valuesByMonth.get(m) ?? 0) > 0),
  );
  const values = priorMonthValues(valuesByMonth, month, withIncome);
  if (values.length < MIN_USUAL_MONTHS) return null;
  const mid = median(values);
  if (mid === null || mid <= 0) return null;
  if ((Math.max(...values) - Math.min(...values)) * REGULAR_SPREAD_PARTS > mid) return null;
  return mid;
}
