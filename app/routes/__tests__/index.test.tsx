import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router';

vi.mock('~/components/layout/DefaultLayout', () => ({
  DefaultLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/budget/WelcomeBackCard', () => ({ WelcomeBackCard: () => null }));
vi.mock('~/components/layout/WhatsChanged', () => ({ WhatsChanged: () => null }));
vi.mock('~/components/layout/GuidedTour', () => ({ GuidedTour: () => null }));
vi.mock('~/components/recurring/DueRecurringCard', () => ({ DueRecurringCard: () => <div>Due card</div> }));
vi.mock('~/hooks/useOfflineQueue', () => ({ useOfflineQueue: () => ({ pendingMap: {}, flushNow: vi.fn(), discard: vi.fn() }) }));
vi.mock('~/components/transactions/TransactionSheet', () => ({
  TransactionSheet: ({ opened, editing }: { opened: boolean; editing?: { description: string } | null }) =>
    opened ? <div>{editing ? `Editing ${editing.description}` : 'Sheet open'}</div> : null,
}));
vi.mock('~/components/recurring/RecurringForm', () => ({ RecurringForm: () => null }));
const data = vi.hoisted(() => ({
  categories: [] as unknown[], targets: [] as unknown[], pots: [] as unknown[], transactions: [] as unknown[],
  potsCalls: [] as [string, boolean | undefined][],
  potsLoading: false,
  potsError: null as Error | null,
  // When set for a month, that month's transactions come from here instead of `transactions`.
  byMonth: {} as Record<string, unknown[]>,
  txCalls: [] as [string, boolean | undefined][],
  // Transactions in the last 12 months: any entry means the person has used the app before.
  history: [{}] as unknown[],
  recurring: [] as unknown[],
}));
vi.mock('~/lib/queries', () => ({
  useCategories: () => ({ data: data.categories, isLoading: false, error: null, refetch: vi.fn() }),
  useTargets: () => ({ data: data.targets, isLoading: false, error: null, refetch: vi.fn() }),
  usePots: (asOf: string, enabled?: boolean) => {
    data.potsCalls.push([asOf, enabled]);
    return { data: data.pots, isLoading: data.potsLoading, error: data.potsError };
  },
  useTransactions: (month: string, enabled?: boolean) => {
    data.txCalls.push([month, enabled]);
    return { data: data.byMonth[month] ?? data.transactions, isLoading: false, error: null, refetch: vi.fn() };
  },
  useTransactionsRange: () => ({ isSuccess: true, data: data.history }),
  useRecurring: () => ({ data: data.recurring, isLoading: false, error: null }),
  useDeleteTransaction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useRestoreFromTrash: () => ({ mutateAsync: vi.fn() }),
}));

import Home from '../_index';
import { currentYearMonth, formatMonthLabel, monthName, shiftMonth } from '~/lib/months';
import { expectNoViolations, expectSoundHeadings } from '~/test-utils/accessibility';

const thisMonth = currentYearMonth();
const lastMonth = shiftMonth(thisMonth, -1);

const groceries = { categoryId: 'g', name: 'Groceries', type: 'EXPENSE', group: 'EVERYDAY', icon: 'tag', isDefault: true, createdAt: '' };
const dining = { categoryId: 'd', name: 'Dining', type: 'EXPENSE', group: 'EVERYDAY', icon: 'tag', isDefault: true, createdAt: '' };
const salary = { categoryId: 's', name: 'Salary', type: 'INCOME', icon: 'tag', isDefault: true, createdAt: '' };

function txn(over: Record<string, unknown>) {
  return {
    transactionId: 't1', yearMonth: thisMonth, amount: 1000, type: 'EXPENSE', categoryId: 'g',
    description: '', date: `${thisMonth}-01`, createdAt: '', ...over,
  };
}

function renderHome(url: string = '/') {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[url]}>
        <Home />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('Home', () => {
  beforeEach(() => {
    data.categories = [];
    data.targets = [];
    data.pots = [];
    data.transactions = [];
    data.potsCalls = [];
    data.potsLoading = false;
    data.potsError = null;
    data.byMonth = {};
    data.txCalls = [];
    data.recurring = [];
    window.localStorage.clear();
  });

  it('shows the Due card above the month header', () => {
    renderHome();
    const card = screen.getByText('Due card');
    const header = screen.getByRole('heading', { level: 2, name: formatMonthLabel(currentYearMonth()) });
    expect(card.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the page heading first in the page', () => {
    renderHome();
    const [first] = screen.getAllByRole('heading');
    expect(first).toHaveTextContent('Home');
    expect(first.tagName).toBe('H1');
  });

  it('always links to the Recurring page', () => {
    renderHome();
    expect(screen.getByRole('link', { name: 'Manage recurring' })).toHaveAttribute('href', '/plan?tab=recurring');
  });

  it('shows group sub-headings inside the spending section, in group order', () => {
    data.categories = [
      { categoryId: 'g', name: 'Groceries', type: 'EXPENSE', group: 'EVERYDAY', icon: 'tag', isDefault: true, createdAt: '' },
      { categoryId: 'm', name: 'Mortgage', type: 'EXPENSE', group: 'BILLS', icon: 'tag', isDefault: true, createdAt: '' },
    ];
    data.targets = [
      { categoryId: 'g', targetAmount: 30000, period: 'MONTHLY', updatedAt: '' },
      { categoryId: 'm', targetAmount: 100000, period: 'MONTHLY', updatedAt: '' },
    ];
    renderHome();
    const bills = screen.getByText('Bills');
    const everyday = screen.getByText('Everyday Spending');
    expect(bills.compareDocumentPosition(everyday) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a Pots section with balances and a link to the Pots page', () => {
    data.categories = [
      { categoryId: 'cat-holidays', name: 'Holidays', type: 'POT', group: 'SINKING_FUNDS', icon: '✈️', isDefault: true, createdAt: '' },
    ];
    data.pots = [{
      categoryId: 'cat-holidays', monthlyAmount: null, goalAmount: null, autoAmountNow: 0, balance: 12000,
      thisMonth: { setAside: 0, autoAdded: 0, takeOut: 0, spent: 0 }, months: [],
    }];
    renderHome();
    expect(screen.getByRole('heading', { name: 'Pots' })).toBeInTheDocument();
    expect(screen.getByText('£120.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all pots' })).toHaveAttribute('href', '/plan?tab=pots');
  });

  it('counts money put into pots for the viewed month on the summary', () => {
    data.categories = [
      { categoryId: 'cat-holidays', name: 'Holidays', type: 'POT', group: 'SINKING_FUNDS', icon: '✈️', isDefault: true, createdAt: '' },
    ];
    data.pots = [{
      categoryId: 'cat-holidays', monthlyAmount: null, goalAmount: null, autoAmountNow: 0, balance: 12000,
      thisMonth: { setAside: 0, autoAdded: 0, takeOut: 0, spent: 0 },
      months: [{ yearMonth: thisMonth, opening: 2000, setAside: 7000, autoAdded: 3000, takeOut: 0, spent: 0, closing: 12000 }],
    }];
    renderHome();
    expect(screen.getByText('Put into pots £100.00')).toBeInTheDocument();
  });

  it('shows a placeholder instead of the bar while pots load', () => {
    data.potsLoading = true;
    renderHome();
    expect(screen.getByText('Loading your figures…')).toBeInTheDocument();
    expect(screen.queryByText(/Spent \+ put away/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Put into pots/)).not.toBeInTheDocument();
  });

  it('says the put-away figures could not load when pots fail', () => {
    data.potsError = new Error('boom');
    renderHome();
    expect(screen.getByText("We couldn't load your put-away figures. Nothing has been lost.")).toBeInTheDocument();
    expect(screen.queryByText(/Put into pots/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Spent \+ put away/)).not.toBeInTheDocument();
  });

  it('still shows the bar with nothing put into pots when pots are not enabled', () => {
    data.potsLoading = true;
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('Put into pots £0.00')).toBeInTheDocument();
  });

  it('does not show a Pots section when there are no pots', () => {
    renderHome();
    expect(screen.queryByRole('heading', { name: 'Pots' })).not.toBeInTheDocument();
  });

  describe('pots month bound', () => {
    beforeEach(() => {
      data.categories = [
        { categoryId: 'cat-holidays', name: 'Holidays', type: 'POT', group: 'SINKING_FUNDS', icon: '✈️', isDefault: true, createdAt: '' },
      ];
      data.pots = [{
        categoryId: 'cat-holidays', monthlyAmount: null, goalAmount: null, autoAmountNow: 0, balance: 12000,
        thisMonth: { setAside: 0, autoAdded: 0, takeOut: 0, spent: 0 }, months: [],
      }];
    });

    const lastCall = () => data.potsCalls[data.potsCalls.length - 1];

    it('enables the pots query at the current month', () => {
      renderHome();
      expect(lastCall()[1]).toBe(true);
      expect(screen.getByRole('heading', { name: 'Pots' })).toBeInTheDocument();
    });

    it('keeps pots enabled one month ahead', () => {
      renderHome();
      fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
      expect(lastCall()[1]).toBe(true);
      expect(screen.getByRole('heading', { name: 'Pots' })).toBeInTheDocument();
    });

    it('disables pots and hides the section two months ahead', () => {
      renderHome();
      fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
      fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
      expect(lastCall()[1]).toBe(false);
      expect(screen.queryByRole('heading', { name: 'Pots' })).not.toBeInTheDocument();
      expect(screen.queryByText("We couldn't load your pots. Nothing has been lost.")).not.toBeInTheDocument();
    });
  });
});

describe('Home left to spend', () => {
  beforeEach(() => {
    data.categories = [groceries, dining, salary];
    data.targets = [{ categoryId: 'g', targetAmount: 25000, period: 'MONTHLY', updatedAt: '' }];
    data.pots = [];
    data.potsCalls = [];
    data.transactions = [
      txn({ transactionId: 'a', amount: 18240, categoryId: 'g', description: 'Weekly Shop' }),
      txn({ transactionId: 'b', amount: 3000, categoryId: 'd', description: 'Pizza' }),
    ];
    window.localStorage.clear();
  });

  it('opens with how much is left and how many days remain', () => {
    renderHome();
    expect(screen.getByText(/^£67\.60 left in your budgets this month · \d+ days? to go$/)).toBeInTheDocument();
  });

  it('describes going over calmly', () => {
    data.transactions = [txn({ amount: 29000, categoryId: 'g' })];
    renderHome();
    expect(screen.getByText('£40.00 over so far. Nothing needs doing today.')).toBeInTheDocument();
  });

  it('describes a past month without a days count', () => {
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByText(`£67.60 left in your budgets at the end of ${monthName(lastMonth)}`)).toBeInTheDocument();
    expect(screen.queryByText(/days? to go/)).not.toBeInTheDocument();
  });

  it('shows everything spent, including spending without a target', () => {
    renderHome();
    expect(screen.getByText('Actually spent: £212.40')).toBeInTheDocument();
  });

  it('leads each category row with what is left', () => {
    renderHome();
    expect(screen.getByText('£67.60 left')).toBeInTheDocument();
    expect(screen.getByText('£182.40 spent of £250.00')).toBeInTheDocument();
  });

  it('says how much a category is over', () => {
    data.transactions = [txn({ amount: 26200, categoryId: 'g' })];
    renderHome();
    expect(screen.getByText('£12.00 over')).toBeInTheDocument();
  });

  it('links each category to its transactions for the month', () => {
    renderHome();
    expect(screen.getByRole('link', { name: /Groceries/ }))
      .toHaveAttribute('href', `/transactions?month=${thisMonth}&category=g`);
  });

  it('links spending without a budget to the filtered list', () => {
    renderHome();
    const link = screen.getByRole('link', { name: /Other spending \(no budget\)/ });
    expect(link).toHaveTextContent('£30.00');
    expect(link).toHaveAttribute('href', `/transactions?month=${thisMonth}&spending=untargeted`);
  });

  it('opens Edit when a Recent row is tapped', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole('button', { name: 'Edit Weekly Shop' }));
    expect(screen.getByText('Editing Weekly Shop')).toBeInTheDocument();
  });

  it('offers the row menu, including Delete, on Recent rows', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole('button', { name: 'Actions for Pizza' }));
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('names the month on labels when viewing another month', () => {
    data.transactions = [];
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    const name = monthName(lastMonth);
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Where it went')).toBeInTheDocument();
    expect(screen.getByText(`Nothing logged in ${name}.`)).toBeInTheDocument();
  });
});

describe('Home without targets', () => {
  beforeEach(() => {
    data.categories = [groceries, salary];
    data.targets = [];
    data.pots = [];
    data.potsCalls = [];
    data.transactions = [txn({ amount: 4500, categoryId: 'g' })];
    window.localStorage.clear();
  });

  it('shows only what was spent', () => {
    renderHome();
    expect(screen.getByText('Actually spent: £45.00')).toBeInTheDocument();
    expect(screen.queryByText(/left to spend|over so far/)).not.toBeInTheDocument();
    expect(screen.queryByText('Other spending (no budget)')).not.toBeInTheDocument();
  });

  it('explains that budgets are optional', () => {
    renderHome();
    expect(screen.getByText("Budgets are optional. Set one to see what's left in a category.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set budgets' })).toHaveAttribute('href', '/plan?tab=budgets');
  });

  it('hides the budgets card for good after "Just tracking for now"', async () => {
    const user = userEvent.setup();
    const { unmount } = renderHome();
    await user.click(screen.getByRole('button', { name: 'Just tracking for now' }));
    expect(screen.queryByText(/Budgets are optional/)).not.toBeInTheDocument();

    unmount();
    renderHome();
    expect(screen.queryByText(/Budgets are optional/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Actually spent:/)).toBeInTheDocument();
  });

  it('still shows the card when storage cannot be read', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHome();
    expect(screen.getByText(/Budgets are optional/)).toBeInTheDocument();
    getItem.mockRestore();
    error.mockRestore();
  });
});

describe('Home page title', () => {
  it('names the month shown and follows month changes', async () => {
    renderHome();
    expect(document.title).toBe(`Home – ${formatMonthLabel(currentYearMonth())} – Hoardwise`);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous month' }));

    expect(document.title).toBe(`Home – ${formatMonthLabel(shiftMonth(currentYearMonth(), -1))} – Hoardwise`);
  });
});

describe('Home pace and weekly targets', () => {
  const weeklyGroceries = [{ categoryId: 'g', targetAmount: 2000, period: 'WEEKLY', updatedAt: '' }];
  const monthlyGroceries = [{ categoryId: 'g', targetAmount: 25000, period: 'MONTHLY', updatedAt: '' }];

  function pretendItIs(year: number, monthIndex: number, day: number): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(year, monthIndex, day, 12));
  }

  beforeEach(() => {
    data.categories = [groceries];
    data.pots = [];
    data.potsCalls = [];
    data.transactions = [];
    data.byMonth = {};
    data.txCalls = [];
    window.localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('marks how far through the month it is on each row', () => {
    pretendItIs(2026, 9, 14); // 14 October: day 14 of 31
    data.targets = monthlyGroceries;
    data.transactions = [txn({ yearMonth: '2026-10', date: '2026-10-05', amount: 5000 })];
    renderHome();
    expect(screen.getByTestId('pace-marker')).toHaveStyle({ left: '45%' });
  });

  it('shows no pace marker for a past month', () => {
    pretendItIs(2026, 9, 14);
    data.targets = monthlyGroceries;
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.queryByTestId('pace-marker')).not.toBeInTheDocument();
  });

  it('measures a weekly target against this week, counting days from last month', () => {
    pretendItIs(2026, 9, 1); // Thursday 1 October: the week began Monday 28 September
    data.targets = weeklyGroceries;
    data.byMonth = {
      '2026-10': [txn({ transactionId: 'a', yearMonth: '2026-10', date: '2026-10-01', amount: 300 })],
      '2026-09': [
        txn({ transactionId: 'b', yearMonth: '2026-09', date: '2026-09-29', amount: 900 }),
        txn({ transactionId: 'c', yearMonth: '2026-09', date: '2026-09-10', amount: 4000 }), // earlier in September: not this week
      ],
    };
    renderHome();
    expect(screen.getByText('£8.00 left this week')).toBeInTheDocument();
    expect(screen.getByText(/£12\.00 of £20\.00 this week/)).toBeInTheDocument();
  });

  it('only asks for last month when a weekly target\'s week began in it', () => {
    pretendItIs(2026, 9, 14); // 14 October: the week began 12 October, inside the month
    data.targets = weeklyGroceries;
    renderHome();
    expect(data.txCalls.filter(([, enabled]) => enabled !== false).map(([month]) => month)).not.toContain('2026-09');

    data.txCalls = [];
    vi.setSystemTime(new Date(2026, 9, 1, 12));
    renderHome();
    expect(data.txCalls.some(([month, enabled]) => month === '2026-09' && enabled === true)).toBe(true);
  });

  it('does not ask for last month when there is no weekly target', () => {
    pretendItIs(2026, 9, 1);
    data.targets = monthlyGroceries;
    renderHome();
    expect(data.txCalls.every(([month, enabled]) => month !== '2026-09' || enabled === false)).toBe(true);
  });
});

describe('Home month in the URL', () => {
  beforeEach(() => {
    data.categories = [];
    data.targets = [];
    data.pots = [];
    data.transactions = [];
    data.potsCalls = [];
    window.localStorage.clear();
  });

  it('opens on the month named in the link', () => {
    renderHome('/?month=2026-08');
    expect(screen.getByRole('heading', { name: 'August 2026' })).toBeInTheDocument();
  });

  it('offers a way back to this month, and takes it', () => {
    renderHome('/?month=2026-08');
    fireEvent.click(screen.getByRole('button', { name: 'Back to this month' }));
    expect(screen.getByRole('heading', { name: formatMonthLabel(thisMonth) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to this month' })).not.toBeInTheDocument();
  });

  it('has no way-back button on the current month', () => {
    renderHome();
    expect(screen.queryByRole('button', { name: 'Back to this month' })).not.toBeInTheDocument();
  });
});

describe('Accessibility', () => {
  it('has one h1 and no skipped heading levels', () => {
    renderHome();
    expectSoundHeadings(document.body);
  });

  it('has no unlabelled controls, empty buttons or empty headings', async () => {
    renderHome();
    await expectNoViolations(document.body);
  });
});

describe('Home money ahead', () => {
  const rent = { recurringId: 'rent', type: 'EXPENSE', categoryId: 'g', amount: 85000, description: 'Rent', dayOfMonth: 20, frequency: 'MONTHLY', anchorDate: null, leadDays: 3, handledPeriod: null, createdAt: '', updatedAt: '' };

  beforeEach(() => {
    data.categories = [groceries];
    data.targets = [];
    data.pots = [];
    data.transactions = [];
    data.recurring = [rent];
    data.byMonth = {};
    window.localStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 10, 12));
  });
  afterEach(() => vi.useRealTimers());

  it('stays out of the way until a pay day is set', () => {
    renderHome();
    expect(screen.queryByText(/Next pay day/)).not.toBeInTheDocument();
  });

  it('says when pay day is and what bills fall due before it, as plain facts', () => {
    window.localStorage.setItem('hoardwise.preferences', JSON.stringify({ payDay: 25 }));
    renderHome();
    expect(screen.getByText('Next pay day: Fri 25 Sep, in 15 days.')).toBeInTheDocument();
    expect(screen.getByText('Bills due before then: £850.00 (1 bill).')).toBeInTheDocument();
  });

  it('says so when nothing is due before pay day', () => {
    window.localStorage.setItem('hoardwise.preferences', JSON.stringify({ payDay: 15 }));
    renderHome();
    expect(screen.getByText('No bills are due before then.')).toBeInTheDocument();
  });

  it('is not shown on another month', () => {
    window.localStorage.setItem('hoardwise.preferences', JSON.stringify({ payDay: 25 }));
    renderHome('/?month=2026-08');
    expect(screen.queryByText(/Next pay day/)).not.toBeInTheDocument();
  });

  it('puts income beside the headline, and says when none has arrived', () => {
    renderHome();
    expect(screen.getByText('No income recorded yet this month.')).toBeInTheDocument();
    expect(screen.getByText('Income')).toBeInTheDocument();
  });
});
