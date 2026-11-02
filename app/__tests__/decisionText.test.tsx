import { describe, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router';
vi.mock('~/lib/queries', () => ({ useSavePot: () => ({ mutate: vi.fn() }) }));

import { AccountHistorySheet } from '~/components/accounts/AccountHistorySheet';
import { AccountRow } from '~/components/accounts/AccountRow';
import { CategoryProgressRow } from '~/components/budget/CategoryProgressRow';
import { SummaryRow } from '~/components/insights/SummaryRow';
import { HomePots } from '~/components/pots/HomePots';
import { PotRow } from '~/components/pots/PotRow';
import { TransactionRow } from '~/components/transactions/TransactionRow';
import { addDaysIso, todayIso } from '~/lib/months';
import type { Account, Category, PotSummary, Transaction } from '~/lib/types';
import { expectReadable } from '~/test-utils/readableText';

// Text that helps a person decide, or find their place, must not be tiny or dimmed.
// Dimmed styling says "you can skip this", so people do.

function renderIn(ui: React.ReactNode) {
  return render(<MantineProvider><MemoryRouter>{ui}</MemoryRouter></MantineProvider>);
}

const holidays: Category = { categoryId: 'holidays', name: 'Holidays', type: 'POT', group: 'SINKING_FUNDS', icon: 'x', isDefault: true, createdAt: '' };

function pot(overrides: Partial<PotSummary> = {}): PotSummary {
  return {
    categoryId: 'holidays', monthlyAmount: 5000, goalAmount: 120000, autoAmountNow: 5000, balance: 40000,
    thisMonth: { setAside: 5000, autoAdded: 0, takeOut: 0, spent: 0 }, months: [], ...overrides,
  };
}

describe('pots', () => {
  it('shows goal progress and this month on the Pots page at a readable size', () => {
    renderIn(<PotRow pot={pot()} category={holidays} onSetAside={() => undefined} />);
    expectReadable(screen.getByText('£400.00 of £1,200.00'));
    expectReadable(screen.getByText(/added to pot/i, { selector: 'p' }));
  });

  it('shows the auto and below-zero badges at a readable size', () => {
    renderIn(<PotRow pot={pot({ balance: -500 })} category={holidays} onSetAside={() => undefined} />);
    expectReadable(screen.getByText('Below zero').closest('.mantine-Badge-root') as HTMLElement);
    expectReadable(screen.getByText(/^Auto /).closest('.mantine-Badge-root') as HTMLElement);
  });

  it('shows goal progress on Home at a readable size', () => {
    renderIn(<HomePots pots={[pot()]} categories={[holidays]} />);
    expectReadable(screen.getByText('£400.00 of £1,200.00'));
  });
});

describe('accounts', () => {
  const account: Account = {
    accountId: 'a', name: 'Lloyds', kind: 'ASSET', type: 'CASH',
    balances: [{ date: addDaysIso(todayIso(), -23), pence: 100000 }], createdAt: '',
  };

  it('shows how long ago a balance was entered at a readable size', () => {
    renderIn(<AccountRow account={account} onOpen={() => undefined} onDelete={() => undefined} onUpdate={() => undefined} />);
    expectReadable(screen.getByText('Updated 23 days ago'));
    expectReadable(screen.getByText('Cash'));
  });

  it('does the same in the history sheet', () => {
    renderIn(<AccountHistorySheet account={account} onClose={() => undefined} onUpdate={() => undefined} />);
    expectReadable(screen.getByText('Updated 23 days ago'));
    // "Balance" is also a table heading; the label is the paragraph.
    expectReadable(screen.getAllByText('Balance').find(element => element.tagName === 'P') as HTMLElement);
  });
});

describe('transactions', () => {
  const transaction: Transaction = {
    transactionId: 't1', yearMonth: '2026-09', amount: 1000, type: 'EXPENSE', categoryId: 'cat-food',
    description: 'Weekly Shop', date: '2026-09-10', createdAt: '',
  };

  it('shows the category and day under each entry at a readable size', () => {
    renderIn(<TransactionRow transaction={transaction} categoryName="Groceries" categoryIcon="shopping-cart" />);
    expectReadable(screen.getByText(/^Groceries · /));
  });

  it('shows sync status at a readable size', () => {
    renderIn(
      <>
        <TransactionRow transaction={transaction} categoryName="Groceries" categoryIcon="x" pending pendingError="rejected" onRetry={() => undefined} />
        <TransactionRow transaction={{ ...transaction, transactionId: 't2', description: 'Petrol' }} categoryName="Fuel" categoryIcon="x" pending />
        <TransactionRow transaction={{ ...transaction, transactionId: 't3', description: 'Coffee' }} categoryName="Dining" categoryIcon="x" saving />
      </>,
    );
    expectReadable(screen.getByText('Not synced. Tap to retry.'));
    expectReadable(screen.getByText('Waiting to sync'));
    expectReadable(screen.getByText('Saving'));
  });
});

describe('budget', () => {
  it('shows what was spent of the target, and the weekly amount, at a readable size', () => {
    renderIn(
      <CategoryProgressRow
        progress={{ categoryId: 'g', name: 'Groceries', icon: 'x', spent: 5000, target: 30000, rawTarget: 7000, period: 'WEEKLY', percent: 17, isOver: false }}
      />,
    );
    expectReadable(screen.getByText(/spent of/));
    expectReadable(screen.getByText(/a week/));
  });

  it('names the pace line at a readable size, and does not dim it', () => {
    renderIn(
      <CategoryProgressRow
        progress={{ categoryId: 'g', name: 'Groceries', icon: 'x', spent: 5000, target: 30000, rawTarget: 30000, period: 'MONTHLY', percent: 17, isOver: false }}
        pace={40}
        paceCaption
      />,
    );
    expectReadable(screen.getByText(/Today · 40%/));
  });
});

describe('insights', () => {
  it('labels each figure and its change at a readable size', () => {
    renderIn(
      <SummaryRow
        current={{ income: 100000, spent: 50000, saved: 0, net: 50000 }}
        previous={{ income: 90000, spent: 60000, saved: 0, net: 30000 }}
      />,
    );
    expectReadable(screen.getByText('Income'));
    expectReadable(screen.getByText('£100.00 more (11%)'));
  });
});
