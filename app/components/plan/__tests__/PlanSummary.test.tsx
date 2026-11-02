import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import type { Category, CategoryTarget, PotSummary } from '~/lib/types';

const state = vi.hoisted(() => ({
  categories: [] as Category[],
  targets: [] as CategoryTarget[],
  pots: [] as PotSummary[],
  income: null as number | null,
  potsLoading: false,
  targetsError: false,
  save: vi.fn(),
  historyPending: false,
  historyError: false,
  overridePending: false,
  overrideError: false,
}));

vi.mock('~/lib/queries', () => ({
  useCategories: () => ({ data: state.categories, isPending: false, isError: false, refetch: vi.fn() }),
  useTargets: () => ({
    data: state.targetsError ? undefined : state.targets,
    isPending: false,
    isError: state.targetsError,
    refetch: vi.fn(),
  }),
  usePots: () => ({
    data: state.potsLoading ? undefined : state.pots,
    isPending: state.potsLoading,
    isError: false,
    refetch: vi.fn(),
  }),
  useTransactionsRange: () => ({
    data: state.historyPending || state.historyError ? undefined : [],
    isPending: state.historyPending,
    isError: state.historyError,
  }),
  useExpectedIncomeValue: () => (state.overridePending || state.overrideError ? null : state.income),
  useExpectedIncome: () => ({
    data: state.overridePending || state.overrideError ? undefined : { amount: null },
    isPending: state.overridePending,
    isError: state.overrideError,
    refetch: vi.fn(),
  }),
  useSetExpectedIncome: () => ({ mutate: vi.fn() }),
  useClearExpectedIncome: () => ({ mutate: vi.fn() }),
  useSavePot: () => ({
    mutate: (vars: unknown, callbacks: { onSuccess?: () => void }) => {
      state.save(vars);
      callbacks.onSuccess?.();
    },
  }),
}));

import { PlanSummary } from '../PlanSummary';
import { PlanDraftProvider } from '../PlanDraftContext';
import { PotPlanField } from '~/components/pots/PotPlanField';

function expense(id: string): Category {
  return { categoryId: id, name: id, type: 'EXPENSE', group: 'EVERYDAY', icon: 'tag', isDefault: true, createdAt: '' };
}

function potCategory(id: string): Category {
  return { categoryId: id, name: id, type: 'POT', group: 'SINKING_FUNDS', icon: 'tag', isDefault: true, createdAt: '' };
}

function pot(categoryId: string, monthlyAmount: number | null, archivedAt: string | null = null): PotSummary {
  return {
    categoryId, monthlyAmount, goalAmount: null, autoAmountNow: 0, balance: 0, archivedAt,
    thisMonth: { setAside: 0, autoAdded: 0, takeOut: 0, spent: 0 }, months: [],
  };
}

function target(categoryId: string, targetAmount: number): CategoryTarget {
  return { categoryId, targetAmount, period: 'MONTHLY', updatedAt: '' };
}

beforeEach(() => {
  state.categories = [expense('food'), expense('rent'), potCategory('holiday'), potCategory('car')];
  state.targets = [target('food', 100000), target('rent', 297899)];
  state.pots = [pot('holiday', 100000), pot('car', 41479)];
  state.income = 488129;
  state.potsLoading = false;
  state.targetsError = false;
  state.save.mockReset();
  state.historyPending = false;
  state.historyError = false;
  state.overridePending = false;
  state.overrideError = false;
});

function Page({ showField = true }: { showField?: boolean }) {
  return (
    <MantineProvider>
      <PlanDraftProvider>
        <PlanSummary />
        {showField && <PotPlanField pot={state.pots[0]} />}
      </PlanDraftProvider>
    </MantineProvider>
  );
}

describe('PlanSummary', () => {
  it('shows budgeted spending plus planned for pots', () => {
    render(<Page showField={false} />);
    expect(screen.getByText('Total budgeted: £5,393.78')).toBeInTheDocument();
    expect(screen.getByText(/Budgeted spending £3,978.99/)).toBeInTheDocument();
    expect(screen.getByText(/Planned for pots £1,414.79/)).toBeInTheDocument();
  });

  it('compares with expected income', () => {
    render(<Page showField={false} />);
    expect(screen.getByText('£512.49 more than expected income')).toBeInTheDocument();
  });

  it('shows Set your own and no over/under line with no income', () => {
    state.income = null;
    render(<Page showField={false} />);
    expect(screen.getByRole('button', { name: 'Set your own' })).toBeInTheDocument();
    expect(screen.queryByText(/more than expected income/)).not.toBeInTheDocument();
    expect(screen.queryByText(/left after pots/)).not.toBeInTheDocument();
  });

  it('ignores archived pots and targets for categories that are not expenses', () => {
    state.pots = [pot('holiday', 100000), pot('car', 41479, '2026-01-01')];
    state.targets = [...state.targets, target('holiday', 99999), target('gone', 5000)];
    render(<Page showField={false} />);
    expect(screen.getByText('Total budgeted: £4,978.99')).toBeInTheDocument();
  });

  it('does not show totals while pots load', () => {
    state.potsLoading = true;
    render(<Page showField={false} />);
    expect(screen.queryByText(/Total budgeted/)).not.toBeInTheDocument();
    expect(screen.getByText(/Loading your plan/)).toBeInTheDocument();
  });

  it('shows a load error instead of totals when budgets fail', () => {
    state.targetsError = true;
    render(<Page showField={false} />);
    expect(screen.queryByText(/Total budgeted/)).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't load/)).toBeInTheDocument();
  });

  it('updates Total budgeted as a pot amount is typed', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const field = screen.getByLabelText('Planned per month');
    await user.clear(field);
    await user.type(field, '1100');
    expect(screen.getByText('Total budgeted: £5,493.78')).toBeInTheDocument();
    expect(state.save).not.toHaveBeenCalled();
  });

  it('uses the saved amount after leaving without saving', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Page />);
    await user.clear(screen.getByLabelText('Planned per month'));
    await user.type(screen.getByLabelText('Planned per month'), '1100');
    expect(screen.getByText('Total budgeted: £5,493.78')).toBeInTheDocument();

    rerender(<Page showField={false} />);
    expect(screen.getByText('Total budgeted: £5,393.78')).toBeInTheDocument();
  });

  it('keeps the new total through a save while the pots refetch is still catching up', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Page />);
    await user.clear(screen.getByLabelText('Planned per month'));
    await user.type(screen.getByLabelText('Planned per month'), '1100');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(state.save).toHaveBeenCalled();
    expect(screen.getByText('Total budgeted: £5,493.78')).toBeInTheDocument();
    expect(screen.queryByText('Total budgeted: £5,393.78')).not.toBeInTheDocument();

    state.pots = [pot('holiday', 110000), pot('car', 41479)];
    rerender(<Page />);
    expect(screen.getByText('Total budgeted: £5,493.78')).toBeInTheDocument();
  });

  it('shows a placeholder, not Not set, while income history loads', () => {
    state.income = null;
    state.historyPending = true;
    render(<Page showField={false} />);
    expect(screen.getByText('Working out expected income…')).toBeInTheDocument();
    expect(screen.queryByText('Not set')).not.toBeInTheDocument();
    expect(screen.queryByText(/more than expected income|left after pots/)).not.toBeInTheDocument();
    expect(screen.getByText('Total budgeted: £5,393.78')).toBeInTheDocument();
  });

  it('says the history could not be loaded and still offers Set your own', () => {
    state.income = null;
    state.historyError = true;
    render(<Page showField={false} />);
    expect(screen.getByText("We couldn't load your income history.")).toBeInTheDocument();
    expect(screen.queryByText('Not set')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set your own' })).toBeInTheDocument();
  });

  it('shows a placeholder, not Not set, while the saved expected income loads', () => {
    state.income = null;
    state.overridePending = true;
    render(<Page showField={false} />);
    expect(screen.getByText('Working out expected income…')).toBeInTheDocument();
    expect(screen.queryByText('Not set')).not.toBeInTheDocument();
    expect(screen.queryByText(/more than expected income|left after pots/)).not.toBeInTheDocument();
  });

  it('says Unavailable, not Not set, when the saved expected income failed to load', () => {
    state.income = null;
    state.overrideError = true;
    render(<Page showField={false} />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Not set')).not.toBeInTheDocument();
  });

  it('shows Not set only when the saved figure and the history have both settled with nothing', () => {
    state.income = null;
    render(<Page showField={false} />);
    expect(screen.getByText('Not set')).toBeInTheDocument();
  });
});
