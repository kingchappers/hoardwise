import { describe, expect, it } from 'vitest';
import {
  computeMonthFigures,
  expectedIncome,
  plannedFigures,
  type PotMonthInput,
} from '../monthFigures';

const pot = (overrides: Partial<PotMonthInput>): PotMonthInput => ({
  opening: 0,
  setAside: 0,
  autoAdded: 0,
  takeOut: 0,
  spent: 0,
  ...overrides,
});

const noTransactions = { transactions: [], potCategoryIds: new Set<string>() };

describe('computeMonthFigures', () => {
  it('reproduces October 2026', () => {
    const figures = computeMonthFigures({
      transactions: [
        { type: 'INCOME', categoryId: 'salary', amount: 488129 },
        { type: 'EXPENSE', categoryId: 'groceries', amount: 372784 },
        { type: 'EXPENSE', categoryId: 'holiday', amount: 48156 },
      ],
      potCategoryIds: new Set(['holiday']),
      pots: [
        pot({ opening: 100000, setAside: 100000, autoAdded: 41479, spent: 48156 }),
      ],
    });
    expect(figures.actuallySpent).toBe(420940);
    expect(figures.spentAndPutAway).toBe(514263);
    expect(figures.leftAfterPots).toBe(-26134);
    expect(
      figures.income - (figures.expensesOutsidePots + figures.putIntoPots),
    ).toBe(figures.leftAfterPots);
  });

  it('does not count funded pot spending twice', () => {
    const figures = computeMonthFigures({
      ...noTransactions,
      pots: [pot({ opening: 50000, spent: 10000 })],
    });
    expect(figures.unfundedPotSpending).toBe(0);
    expect(figures.spentAndPutAway).toBe(0);
  });

  it('counts the unfunded part of an overdrawn pot', () => {
    const figures = computeMonthFigures({
      ...noTransactions,
      pots: [pot({ opening: 2000, setAside: 1000, spent: 10000 })],
    });
    expect(figures.unfundedPotSpending).toBe(7000);
  });

  it('treats take-outs as reducing what was put in', () => {
    const figures = computeMonthFigures({
      ...noTransactions,
      pots: [pot({ setAside: 5000, takeOut: 2000 })],
    });
    expect(figures.putIntoPots).toBe(3000);
  });
});

describe('plannedFigures', () => {
  it('sums targets and non-null pot amounts', () => {
    expect(
      plannedFigures({
        categoryTargetsMonthly: [397899],
        potMonthlyAmounts: [1667, null],
      }),
    ).toEqual({
      budgetedSpending: 397899,
      plannedForPots: 1667,
      totalBudgeted: 399566,
    });
  });
});

describe('expectedIncome', () => {
  it('prefers the override', () => {
    expect(expectedIncome(500000, 488129)).toBe(500000);
    expect(expectedIncome(null, 488129)).toBe(488129);
    expect(expectedIncome(null, null)).toBeNull();
  });
});
