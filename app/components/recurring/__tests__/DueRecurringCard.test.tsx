import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { Notifications, notifications } from '@mantine/notifications';
import { MemoryRouter, useLocation } from 'react-router';
import type { DueItem } from '~/lib/recurring';
import type { Recurring, Transaction } from '~/lib/types';

const mockSave = vi.fn();
const mockHandled = vi.fn();
const mockRefetch = vi.fn();
const mockLink = vi.fn();
let dueState: { items: DueItem[]; isLoading: boolean; error: Error | null; refetch: () => void };

vi.mock('@auth0/auth0-react', () => ({ useAuth0: () => ({ user: { sub: 'user-1' } }) }));
vi.mock('~/hooks/useDueRecurring', () => ({ useDueRecurring: () => dueState }));
vi.mock('~/hooks/useSaveWithUndo', () => ({ useSaveWithUndo: () => mockSave }));
vi.mock('~/lib/queries', () => ({
  useCategories: () => ({
    data: [
      { categoryId: 'cat-salary', name: 'Salary', type: 'INCOME', icon: 'briefcase', isDefault: true, createdAt: '' },
      { categoryId: 'cat-housing', name: 'Housing', type: 'EXPENSE', icon: 'home', isDefault: true, createdAt: '' },
    ],
  }),
  useSetRecurringHandled: () => ({ mutate: mockHandled }),
  useLinkTransaction: () => ({ mutate: mockLink }),
}));
vi.mock('~/components/transactions/TransactionSheet', () => ({
  TransactionSheet: ({ opened, template, templateDate, recurringId, onSaved, onUndone }: {
    opened: boolean;
    template?: { description: string; amount: number } | null;
    templateDate?: string;
    recurringId?: string;
    onSaved?: (created: unknown) => void;
    onUndone?: () => void;
  }) => (opened
    ? (
      <div>
        <span>{`Sheet ${template?.description} ${template?.amount} on ${templateDate} for ${recurringId}`}</span>
        <button onClick={() => onSaved?.({})}>simulate saved</button>
        <button onClick={() => onUndone?.()}>simulate undone</button>
      </div>
    )
    : null),
}));

import { DueRecurringCard } from '../DueRecurringCard';
import { expectReadable } from '~/test-utils/readableText';

function rec(over: Partial<Recurring>): Recurring {
  return {
    recurringId: 'r1', type: 'INCOME', categoryId: 'cat-salary', amount: 240000, description: 'Salary',
    dayOfMonth: 28, leadDays: 3, handledPeriod: '2026-08', createdAt: '', updatedAt: '', ...over,
  };
}

function item(over: Partial<DueItem> = {}, template: Partial<Recurring> = {}): DueItem {
  return {
    recurring: rec(template), period: '2026-09', dueDate: '2026-09-28', status: 'today', daysAway: 0, likelyMatches: [], ...over,
  };
}

function CurrentSearch() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderCard(url = '/') {
  return render(
    <MantineProvider>
      <Notifications />
      <MemoryRouter initialEntries={[url]}>
        <DueRecurringCard />
        <CurrentSearch />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('DueRecurringCard', () => {
  beforeEach(() => {
    mockSave.mockReset();
    mockSave.mockResolvedValue(null);
    mockHandled.mockReset();
    mockRefetch.mockReset();
    mockLink.mockReset();
    window.localStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 28, 12));
    dueState = { items: [item()], isLoading: false, error: null, refetch: mockRefetch };
  });

  afterEach(() => {
    window.localStorage.removeItem('hoardwise.preferences');
    vi.useRealTimers();
  });

  it('lists each due item with its status, date and signed amount', () => {
    dueState.items = [
      item({ status: 'past', daysAway: -2, dueDate: '2026-09-26' }, { recurringId: 'a', description: 'Rent', type: 'EXPENSE', categoryId: 'cat-housing', amount: 95000 }),
      item({ status: 'upcoming', daysAway: 2, dueDate: '2026-09-30' }, { recurringId: 'b' }),
    ];
    renderCard();

    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('Due 26 Sep')).toBeInTheDocument();
    expectReadable(screen.getByText('Due 26 Sep'));
    expect(screen.getByText('−£950.00')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(screen.getByText('Due in 2 days · 30 Sep')).toBeInTheDocument();
    expect(screen.getByText('+£2,400.00')).toBeInTheDocument();
  });

  it('renders nothing when nothing is due or while loading', () => {
    dueState = { items: [], isLoading: false, error: null, refetch: mockRefetch };
    const { container, unmount } = renderCard();
    expect(container.querySelector('.mantine-Card-root')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();

    dueState = { items: [item()], isLoading: true, error: null, refetch: mockRefetch };
    const loading = renderCard();
    expect(loading.container.querySelector('.mantine-Card-root')).toBeNull();
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
  });

  it('shows a compact error with a retry when the templates fail to load', async () => {
    dueState = { items: [], isLoading: false, error: new Error('boom'), refetch: mockRefetch };
    renderCard();
    await userEvent.setup().click(within(screen.getByRole('alert')).getByRole('button', { name: /try again/i }));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('links to the Recurring page', () => {
    renderCard();
    expect(screen.getByRole('link', { name: 'Manage' })).toHaveAttribute('href', '/plan?tab=recurring');
  });

  it('Add saves the template on its due date, through the undoable save', async () => {
    renderCard();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add Salary' }));

    expect(mockSave).toHaveBeenCalledWith({
      amount: 240000, type: 'INCOME', categoryId: 'cat-salary', description: 'Salary', date: '2026-09-28', recurringId: 'r1',
    });
    expect(mockHandled).not.toHaveBeenCalled();
  });

  it('skips a dated occurrence by its date and puts back the previous one on Undo', async () => {
    const user = userEvent.setup();
    dueState.items = [item(
      { period: '2026-09-14', dueDate: '2026-09-14', status: 'past', daysAway: -14 },
      { description: 'Car insurance', frequency: 'YEARLY', anchorDate: '2026-09-14', handledPeriod: '2025-09-14' },
    )];
    renderCard();

    await user.click(screen.getByRole('button', { name: 'More actions for Car insurance' }));
    await user.click(await screen.findByRole('menuitem', { name: "Didn't happen" }));

    expect(mockHandled).toHaveBeenCalledWith({ recurringId: 'r1', period: '2026-09-14' });
    expect(await screen.findByText('Skipped Car insurance for 14 Sep')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(mockHandled).toHaveBeenLastCalledWith({ recurringId: 'r1', period: '2025-09-14' });
  });

  it('Undo after a skip clears a marker left in the old format by a frequency change', async () => {
    const user = userEvent.setup();
    dueState.items = [item(
      { period: '2026-09-14', dueDate: '2026-09-14', status: 'past', daysAway: -14 },
      { description: 'Gym', frequency: 'WEEKLY', anchorDate: '2026-09-14', handledPeriod: '2026-10' },
    )];
    renderCard();

    await user.click(screen.getByRole('button', { name: 'More actions for Gym' }));
    await user.click(await screen.findByRole('menuitem', { name: "Didn't happen" }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(mockHandled).toHaveBeenLastCalledWith({ recurringId: 'r1', period: null });
  });

  it.each([
    [undefined, false],
    ['30s', 30000],
    ['10s', 10000],
  ])('keeps the skipped message on screen for the chosen time (%s)', async (undoDuration, expected) => {
    if (undoDuration) window.localStorage.setItem('hoardwise.preferences', JSON.stringify({ undoDuration }));
    const show = vi.spyOn(notifications, 'show');
    show.mockClear();
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: 'More actions for Salary' }));
    await user.click(await screen.findByRole('menuitem', { name: "Didn't happen" }));

    const skipped = show.mock.calls.map(call => call[0]).find(options => String(options.id).startsWith('skipped-'));
    expect(skipped?.autoClose).toBe(expected);
  });

  it('Didn\'t happen marks the period handled and its Undo restores the previous marker', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: 'More actions for Salary' }));
    await user.click(await screen.findByRole('menuitem', { name: "Didn't happen" }));

    expect(mockHandled).toHaveBeenCalledWith({ recurringId: 'r1', period: '2026-09' });
    expect(await screen.findByText('Skipped Salary for September')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(mockHandled).toHaveBeenLastCalledWith({ recurringId: 'r1', period: '2026-08' });
  });

  it('Didn\'t happen\'s Undo can restore an empty marker', async () => {
    const user = userEvent.setup();
    dueState.items = [item({}, { handledPeriod: null })];
    renderCard();

    await user.click(screen.getByRole('button', { name: 'More actions for Salary' }));
    await user.click(await screen.findByRole('menuitem', { name: "Didn't happen" }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(mockHandled).toHaveBeenLastCalledWith({ recurringId: 'r1', period: null });
  });

  it('Add with changes opens the add sheet prefilled on the due date, and marks it handled once saved', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: 'More actions for Salary' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add with changes' }));

    expect(screen.getByText('Sheet Salary 240000 on 2026-09-28 for r1')).toBeInTheDocument();
    expect(mockHandled).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'simulate saved' }));

    await waitFor(() => expect(mockHandled).toHaveBeenCalledWith({ recurringId: 'r1', period: '2026-09' }));
  });

  it('Undo after Edit restores the previous handled period', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: 'More actions for Salary' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add with changes' }));
    await user.click(screen.getByRole('button', { name: 'simulate saved' }));
    await waitFor(() => expect(mockHandled).toHaveBeenCalledWith({ recurringId: 'r1', period: '2026-09' }));
    mockHandled.mockClear();

    await user.click(screen.getByRole('button', { name: 'simulate undone' }));

    expect(mockHandled).toHaveBeenCalledWith({ recurringId: 'r1', period: '2026-08' });
  });

  it('Undo after Edit clears a marker left in the old format by a frequency change', async () => {
    const user = userEvent.setup();
    dueState.items = [item({}, { frequency: 'WEEKLY', anchorDate: '2026-09-14', handledPeriod: '2026-08' })];
    renderCard();

    await user.click(screen.getByRole('button', { name: 'More actions for Salary' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add with changes' }));
    await user.click(screen.getByRole('button', { name: 'simulate undone' }));

    expect(mockHandled).toHaveBeenCalledWith({ recurringId: 'r1', period: null });
  });

  it('Undo after Edit can restore an empty handled marker', async () => {
    const user = userEvent.setup();
    dueState.items = [item({}, { handledPeriod: null })];
    renderCard();

    await user.click(screen.getByRole('button', { name: 'More actions for Salary' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add with changes' }));
    await user.click(screen.getByRole('button', { name: 'simulate undone' }));

    expect(mockHandled).toHaveBeenCalledWith({ recurringId: 'r1', period: null });
  });

  it('ignores a second Add while the first is still saving, then allows a retry once it settles', async () => {
    let settle!: (value: null) => void;
    mockSave.mockReturnValueOnce(new Promise<null>(resolve => { settle = resolve; }));
    mockSave.mockResolvedValue(null);
    const user = userEvent.setup();
    renderCard();
    const addButton = screen.getByRole('button', { name: 'Add Salary' });

    await user.dblClick(addButton);
    expect(mockSave).toHaveBeenCalledTimes(1);

    await act(async () => { settle(null); });
    await user.click(addButton);
    expect(mockSave).toHaveBeenCalledTimes(2);
  });

  it('describes past, current and upcoming bills calmly, without danger colour', () => {
    dueState.items = [
      item({ status: 'past', daysAway: -25, dueDate: '2026-09-03' }, { recurringId: 'a', description: 'Rent', type: 'EXPENSE', categoryId: 'cat-housing' }),
      item({}, { recurringId: 'b' }),
      item({ status: 'upcoming', daysAway: 3, dueDate: '2026-10-01', period: '2026-10' }, { recurringId: 'c', description: 'Phone' }),
    ];
    const { container } = renderCard();

    expect(screen.getByText('Due 3 Sep')).toBeInTheDocument();
    expect(screen.getByText('Due today')).toBeInTheDocument();
    expect(screen.getByText('Due in 3 days · 1 Oct')).toBeInTheDocument();
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/danger/);
  });

  describe('reminders', () => {
    it('points to reminders under the first due bill, until they are on', () => {
      dueState.items = [item({})];
      const { unmount } = renderCard();
      expect(screen.getByRole('link', { name: 'Get a reminder before bills are due' })).toHaveAttribute('href', '/settings');
      unmount();

      window.localStorage.setItem('hoardwise.preferences', JSON.stringify({ billReminders: true }));
      renderCard();
      expect(screen.queryByRole('link', { name: 'Get a reminder before bills are due' })).not.toBeInTheDocument();
      window.localStorage.clear();
    });
  });

  describe('bills from earlier months', () => {
    function older(): DueItem[] {
      return [
        item({ period: '2026-08', dueDate: '2026-08-01', status: 'past', daysAway: -58 }, { recurringId: 'rent', description: 'Rent', type: 'EXPENSE', categoryId: 'cat-housing', amount: 95000 }),
        item({ period: '2026-08', dueDate: '2026-08-05', status: 'past', daysAway: -54 }, { recurringId: 'gym', description: 'Gym', type: 'EXPENSE', categoryId: 'cat-housing', amount: 3000 }),
        item({}, { recurringId: 'salary' }),
      ];
    }

    async function openEarlier(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.click(screen.getByRole('button', { name: /^Earlier bills \(2\)/ }));
    }

    it('keeps them folded away until asked, with this month\'s bills in view', () => {
      dueState.items = older();
      renderCard();

      expect(screen.getByText('Salary')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Earlier bills \(2\), when you are ready/ })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Rent')).not.toBeInTheDocument();
      expect(screen.queryByText(/not logged/i)).not.toBeInTheDocument();
    });

    it('groups them under their month, separate from this month\'s bills', async () => {
      dueState.items = older();
      renderCard();
      await openEarlier(userEvent.setup());

      const group = screen.getByRole('region', { name: 'From August' });
      expect(within(group).getByRole('heading', { name: 'From August' })).toBeInTheDocument();
      expect(within(group).getByText(/Not recorded yet\./)).toBeInTheDocument();
      expect(within(group).getByText('Rent')).toBeInTheDocument();
      expect(within(group).getByText('Gym')).toBeInTheDocument();
      expect(within(group).queryByText('Salary')).not.toBeInTheDocument();
      expect(screen.getByText('Salary')).toBeInTheDocument();
    });

    it('Add all asks first, saying how many bills and how much', async () => {
      const user = userEvent.setup();
      dueState.items = older();
      renderCard();
      await openEarlier(user);

      await user.click(screen.getByRole('button', { name: 'Add all from August' }));

      expect(screen.getByText('Add 2 bills, £980.00 in all?')).toBeInTheDocument();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('Cancel leaves the bills as they were', async () => {
      const user = userEvent.setup();
      dueState.items = older();
      renderCard();
      await openEarlier(user);

      await user.click(screen.getByRole('button', { name: 'Add all from August' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockSave).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Add all from August' })).toBeInTheDocument();
    });

    it('adds every bill in the group once confirmed, each linked to its bill', async () => {
      const user = userEvent.setup();
      dueState.items = older();
      renderCard();
      await openEarlier(user);

      await user.click(screen.getByRole('button', { name: 'Add all from August' }));
      await user.click(screen.getByRole('button', { name: 'Yes, add them' }));

      expect(mockSave).toHaveBeenCalledTimes(2);
      expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ recurringId: 'rent', date: '2026-08-01', amount: 95000 }));
      expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ recurringId: 'gym', date: '2026-08-05' }));
    });

    it('Didn\'t happen skips that month for that bill', async () => {
      const user = userEvent.setup();
      dueState.items = older();
      renderCard();
      await openEarlier(user);

      await user.click(screen.getByRole('button', { name: 'More actions for Gym' }));
      await user.click(await screen.findByRole('menuitem', { name: "Didn't happen" }));

      expect(mockHandled).toHaveBeenCalledWith({ recurringId: 'gym', period: '2026-08' });
      expect(await screen.findByText('Skipped Gym for August')).toBeInTheDocument();
    });
  });

  describe('likely matches', () => {
    const typed: Transaction = {
      transactionId: 'typed-1', yearMonth: '2026-09', amount: 238000, type: 'INCOME', categoryId: 'cat-salary',
      description: 'pay', date: '2026-09-03', createdAt: '',
    };

    it('asks whether a hand-typed entry is the same thing', () => {
      dueState.items = [item({ likelyMatches: [typed] })];
      renderCard();
      const prompt = screen.getByRole('group', { name: 'Possible match for Salary' });
      expect(within(prompt).getByText('Looks like you logged this on 3 Sep. Same thing?')).toBeInTheDocument();
    });

    it('Yes links that entry to the bill', async () => {
      dueState.items = [item({ likelyMatches: [typed] })];
      renderCard();

      await userEvent.setup().click(screen.getByRole('button', { name: "Yes, that's it" }));

      expect(mockLink).toHaveBeenCalledWith({ transaction: typed, recurringId: 'r1' }, expect.anything());
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('says so calmly when linking fails', async () => {
      const showSpy = vi.spyOn(notifications, 'show');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockLink.mockImplementation((_vars: unknown, options: { onError: (error: Error) => void }) => options.onError(new Error('offline')));
      dueState.items = [item({ likelyMatches: [typed] })];
      renderCard();

      await userEvent.setup().click(screen.getByRole('button', { name: "Yes, that's it" }));

      expect(await screen.findByText("Couldn't record Salary as logged. Check your connection and try again.")).toBeInTheDocument();
      // An error stays until it is closed, whatever time the person chose for other messages.
      const failure = showSpy.mock.calls.find(call => String(call[0].message).startsWith("Couldn't record Salary"));
      expect(failure?.[0].autoClose).toBe(false);
      vi.mocked(console.error).mockRestore();
    });

    it('No hides the question, keeps the bill, and remembers the answer', async () => {
      dueState.items = [item({ likelyMatches: [typed] })];
      const { unmount } = renderCard();

      await userEvent.setup().click(screen.getByRole('button', { name: 'No' }));

      expect(screen.queryByText(/Looks like you logged this/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add Salary' })).toBeInTheDocument();
      expect(mockLink).not.toHaveBeenCalled();
      unmount();

      renderCard();
      expect(screen.queryByText(/Looks like you logged this/)).not.toBeInTheDocument();
    });

    it('offers the next candidate after a No', async () => {
      const second = { ...typed, transactionId: 'typed-2', date: '2026-09-10' };
      dueState.items = [item({ likelyMatches: [typed, second] })];
      renderCard();

      await userEvent.setup().click(screen.getByRole('button', { name: 'No' }));

      expect(screen.getByText('Looks like you logged this on 10 Sep. Same thing?')).toBeInTheDocument();
    });
  });

  describe('Remind me tomorrow', () => {
    it('hides the bill until tomorrow', async () => {
      const user = userEvent.setup();
      dueState.items = [item(), item({}, { recurringId: 'r2', description: 'Rent', type: 'EXPENSE', categoryId: 'cat-housing' })];
      const { unmount } = renderCard();

      await user.click(screen.getByRole('button', { name: 'More actions for Salary' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Remind me tomorrow' }));

      expect(screen.queryByRole('button', { name: 'Add Salary' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add Rent' })).toBeInTheDocument();
      expect(await screen.findByText('Salary will show again tomorrow')).toBeInTheDocument();
      expect(mockHandled).not.toHaveBeenCalled();
      unmount();

      renderCard();
      expect(screen.queryByRole('button', { name: 'Add Salary' })).not.toBeInTheDocument();
      cleanup();

      vi.setSystemTime(new Date(2026, 8, 29, 9));
      renderCard();
      expect(screen.getByRole('button', { name: 'Add Salary' })).toBeInTheDocument();
    });

    it('hides the whole card when every bill is snoozed', async () => {
      const user = userEvent.setup();
      const { container } = renderCard();

      await user.click(screen.getByRole('button', { name: 'More actions for Salary' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Remind me tomorrow' }));

      expect(container.querySelector('.mantine-Card-root')).toBeNull();
    });
  });

  describe('opened from a reminder notification', () => {
    it('adds the bill when the notification\'s Add was tapped, the usual way, and clears the address', async () => {
      renderCard('/?due=r1&period=2026-09&action=add');

      await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
      expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ recurringId: 'r1', amount: 240000, date: '2026-09-28' }));
      expect(screen.getByTestId('search')).toHaveTextContent('');
      expect(screen.getByTestId('search').textContent).toBe('');
    });

    it('skips the bill when Skip was tapped, with the usual Undo', async () => {
      renderCard('/?due=r1&period=2026-09&action=skip');

      await waitFor(() => expect(mockHandled).toHaveBeenCalledWith({ recurringId: 'r1', period: '2026-09' }));
      expect(await screen.findByText('Skipped Salary for September')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    });

    it('only opens Home when the notification itself was tapped, doing nothing to the bill', async () => {
      renderCard('/?due=r1&period=2026-09');

      await waitFor(() => expect(screen.getByTestId('search').textContent).toBe(''));
      expect(mockSave).not.toHaveBeenCalled();
      expect(mockHandled).not.toHaveBeenCalled();
    });

    it('ignores an action it does not know', async () => {
      renderCard('/?due=r1&period=2026-09&action=delete');

      await waitFor(() => expect(screen.getByTestId('search').textContent).toBe(''));
      expect(mockSave).not.toHaveBeenCalled();
      expect(mockHandled).not.toHaveBeenCalled();
    });

    it('says so, calmly, when the bill has already been dealt with', async () => {
      dueState.items = [];
      renderCard('/?due=r1&period=2026-09&action=add');

      expect(await screen.findByText('That one is already taken care of.')).toBeInTheDocument();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('does nothing for a different period of the same bill', async () => {
      renderCard('/?due=r1&period=2026-08&action=add');

      expect(await screen.findByText('That one is already taken care of.')).toBeInTheDocument();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('waits until the bills have loaded, then acts once', async () => {
      dueState = { ...dueState, isLoading: true, items: [] };
      const view = renderCard('/?due=r1&period=2026-09&action=add');
      expect(mockSave).not.toHaveBeenCalled();
      expect(screen.getByTestId('search').textContent).toContain('action=add');

      dueState = { ...dueState, isLoading: false, items: [item()] };
      view.rerender(
        <MantineProvider>
          <Notifications />
          <MemoryRouter initialEntries={['/?due=r1&period=2026-09&action=add']}>
            <DueRecurringCard />
            <CurrentSearch />
          </MemoryRouter>
        </MantineProvider>,
      );

      await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    });

    it('does not add it twice if the page renders again', async () => {
      const view = renderCard('/?due=r1&period=2026-09&action=add');
      await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));

      view.rerender(
        <MantineProvider>
          <Notifications />
          <MemoryRouter initialEntries={['/?due=r1&period=2026-09&action=add']}>
            <DueRecurringCard />
            <CurrentSearch />
          </MemoryRouter>
        </MantineProvider>,
      );

      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it('does nothing for an address that does not look like a reminder\'s', async () => {
      renderCard('/?due=../../admin&action=add');
      expect(mockSave).not.toHaveBeenCalled();
      expect(mockHandled).not.toHaveBeenCalled();
    });

    it('keeps other parts of the address', async () => {
      renderCard('/?month=2026-08&due=r1&period=2026-09&action=skip');
      await waitFor(() => expect(mockHandled).toHaveBeenCalled());
      expect(screen.getByTestId('search').textContent).toBe('?month=2026-08');
    });
  });
});
