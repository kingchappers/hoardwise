import { describe, it, expect } from 'vitest';
import { regularIncomeFromHistory } from '../expectedIncome';
import type { Transaction } from '../types';

function income(date: string, amount: number): Transaction {
  return {
    transactionId: `${date}-${amount}`, yearMonth: date.slice(0, 7), amount, type: 'INCOME',
    categoryId: 's', description: '', date, createdAt: '',
  };
}

function monthOfIncome(month: string, amount: number): Transaction[] {
  const days = ['01', '04', '07', '10', '13', '16', '19', '22'];
  return days.map((d, i) => income(`${month}-${d}`, i === 0 ? amount : 0));
}

describe('regularIncomeFromHistory', () => {
  it('returns null with fewer than 3 months', () => {
    const history = [...monthOfIncome('2026-08', 200000), ...monthOfIncome('2026-09', 200000)];
    expect(regularIncomeFromHistory(history, '2026-10')).toBeNull();
  });

  it('returns the median of 3 steady months', () => {
    const history = [
      ...monthOfIncome('2026-07', 200000),
      ...monthOfIncome('2026-08', 201000),
      ...monthOfIncome('2026-09', 200000),
    ];
    expect(regularIncomeFromHistory(history, '2026-10')).toBe(200000);
  });

  it('ignores the month itself and non-income transactions', () => {
    const history = [
      ...monthOfIncome('2026-07', 200000),
      ...monthOfIncome('2026-08', 200000),
      ...monthOfIncome('2026-09', 200000),
      ...monthOfIncome('2026-10', 900000),
      { ...income('2026-09-02', 500000), type: 'EXPENSE' as const },
    ];
    expect(regularIncomeFromHistory(history, '2026-10')).toBe(200000);
  });
});
