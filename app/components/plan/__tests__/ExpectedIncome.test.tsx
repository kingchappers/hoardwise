import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';

type Callbacks = { onSuccess?: () => void; onError?: (error: Error) => void };

const state = vi.hoisted(() => ({
  override: null as number | null,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
  fail: false,
  set: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('~/lib/queries', () => ({
  useExpectedIncome: () => ({
    data: state.isPending || state.isError ? undefined : { amount: state.override },
    isPending: state.isPending,
    isError: state.isError,
    refetch: state.refetch,
  }),
  useSetExpectedIncome: () => ({
    mutate: (amount: number, callbacks: Callbacks) => {
      state.set(amount);
      if (state.fail) callbacks.onError?.(new Error('boom'));
      else callbacks.onSuccess?.();
    },
  }),
  useClearExpectedIncome: () => ({
    mutate: (_vars: undefined, callbacks: Callbacks) => {
      state.clear();
      if (state.fail) callbacks.onError?.(new Error('boom'));
      else callbacks.onSuccess?.();
    },
  }),
}));

import { ExpectedIncome } from '../ExpectedIncome';

function renderIt(regular: number | null, reason?: 'ok' | 'too-few-months' | 'varies') {
  render(<MantineProvider><ExpectedIncome regular={regular} reason={reason} /></MantineProvider>);
  return userEvent.setup();
}

beforeEach(() => {
  state.override = null;
  state.isPending = false;
  state.isError = false;
  state.fail = false;
  state.set.mockReset();
  state.clear.mockReset();
  state.refetch.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ExpectedIncome', () => {
  it('shows "Set your own" and the empty-history line when nothing is known', () => {
    renderIt(null);
    expect(screen.getByText('Not enough history yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set your own' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use my usual' })).toBeNull();
  });

  it('says the income varies too much when there is history but no usual figure', () => {
    renderIt(null, 'varies');
    expect(screen.getByText('Your income varies too much to work out a usual figure')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set your own' })).toBeTruthy();
  });

  it('says there is not enough history when there are too few months', () => {
    renderIt(null, 'too-few-months');
    expect(screen.getByText('Not enough history yet')).toBeTruthy();
  });

  it('shows the history source when there is no override', () => {
    renderIt(200000);
    expect(screen.getByText('Your usual monthly income, from recent months')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use my usual' })).toBeNull();
  });

  it('shows the override and "Set by you"', () => {
    state.override = 250000;
    renderIt(200000);
    expect(screen.getByText('Set by you')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Expected income' })).toHaveProperty('value', '2500.00');
  });

  it('saves a typed amount in pence and shows Saved', async () => {
    const user = renderIt(null);
    await user.type(screen.getByRole('textbox', { name: 'Expected income' }), '1800');
    await user.click(screen.getByRole('button', { name: 'Set your own' }));
    expect(state.set).toHaveBeenCalledWith(180000);
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it.each([['empty', ''], ['zero', '0'], ['letters', 'abc']])('does not save %s input and shows a message', async (_name, text) => {
    const user = renderIt(null);
    if (text) await user.type(screen.getByRole('textbox', { name: 'Expected income' }), text);
    await user.click(screen.getByRole('button', { name: 'Set your own' }));
    expect(state.set).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Expected income' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('shows an error after a failed save and Retry saves again', async () => {
    state.fail = true;
    const user = renderIt(null);
    await user.type(screen.getByRole('textbox', { name: 'Expected income' }), '1800');
    await user.click(screen.getByRole('button', { name: 'Set your own' }));
    expect(screen.getByText("Couldn't save.")).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.set).toHaveBeenCalledTimes(2);
    expect(state.clear).not.toHaveBeenCalled();
  });

  it('clearing calls the clear mutation', async () => {
    state.override = 250000;
    const user = renderIt(200000);
    await user.click(screen.getByRole('button', { name: 'Use my usual' }));
    expect(state.clear).toHaveBeenCalledTimes(1);
  });

  it('retries a failed clear with clear, not save', async () => {
    state.override = 250000;
    state.fail = true;
    const user = renderIt(200000);
    await user.click(screen.getByRole('button', { name: 'Use my usual' }));
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.clear).toHaveBeenCalledTimes(2);
    expect(state.set).not.toHaveBeenCalled();
  });

  it('shows a loading line and no form while the override is loading', () => {
    state.isPending = true;
    renderIt(200000);
    expect(screen.getByText('Loading your expected income…')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set your own' })).toBeNull();
    expect(screen.queryByText('Your usual monthly income, from recent months')).toBeNull();
  });

  it('shows an error with Try again and no form when the override failed to load', async () => {
    state.isError = true;
    const user = renderIt(200000);
    expect(screen.getByText("We couldn't load your expected income")).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set your own' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use my usual' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});
