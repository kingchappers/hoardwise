import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { HomeSummary } from '../HomeSummary';
import { currentYearMonth } from '~/lib/months';
import type { MonthSummary } from '~/lib/summary';
import type { MonthFigures } from '../../../../src/shared/monthFigures';

function summary(overrides: Partial<MonthSummary> = {}): MonthSummary {
  return {
    spending: [{ categoryId: 'g', name: 'Groceries', target: 40000, spent: 10000, period: 'MONTHLY', rawTarget: 40000 }] as MonthSummary['spending'],
    incomeTotal: 260000, recent: [], budgetedTotal: 40000, spentInBudgeted: 10000, spentTotal: 95000, spentUnbudgeted: 85000, leftToSpend: 30000,
    ...overrides,
  };
}

function figures(overrides: Partial<MonthFigures> = {}): MonthFigures {
  return {
    income: 260000, expensesOutsidePots: 95000, putIntoPots: 20000, unfundedPotSpending: 0,
    spentAndPutAway: 115000, actuallySpent: 95000, leftAfterPots: 145000,
    ...overrides,
  };
}

function renderSummary(value: MonthSummary, monthFigures: MonthFigures = figures()) {
  return render(<MantineProvider><HomeSummary summary={value} figures={monthFigures} yearMonth={currentYearMonth()} /></MantineProvider>);
}

describe('HomeSummary', () => {
  it('calls the figure what is left in your budgets, not what you can spend', () => {
    renderSummary(summary());
    expect(screen.getByText(/^£300\.00 left in your budgets this month/)).toBeInTheDocument();
    expect(screen.queryByText(/left to spend/)).not.toBeInTheDocument();
  });

  it('says what the figure leaves out', () => {
    renderSummary(summary());
    expect(screen.getByText('This counts only categories with a budget. £850.00 of other spending is not included.')).toBeInTheDocument();
  });

  it('still says what it counts when nothing else was spent', () => {
    renderSummary(summary({ spentUnbudgeted: 0, spentTotal: 10000 }));
    expect(screen.getByText('This counts only categories with a budget.')).toBeInTheDocument();
  });

  it('shows spent plus put away and actually spent from the month figures', () => {
    renderSummary(summary());
    expect(screen.getByText('Spent + put away: £1,150.00')).toBeInTheDocument();
    expect(screen.getByText('Actually spent: £950.00')).toBeInTheDocument();
    expect(screen.getByText('£1,450.00 left after pots')).toBeInTheDocument();
  });

  it('says how far outgoings run past income', () => {
    renderSummary(summary(), figures({ expensesOutsidePots: 380000, spentAndPutAway: 400000, leftAfterPots: -140000 }));
    expect(screen.getByText('£1,400.00 more than your income')).toBeInTheDocument();
  });

  it('still says when no income is recorded this month', () => {
    renderSummary(summary({ incomeTotal: 0 }), figures({ income: 0 }));
    expect(screen.getByText('No income recorded yet this month.')).toBeInTheDocument();
  });
});
