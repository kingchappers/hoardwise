import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';

const state = vi.hoisted(() => ({
  override: null as number | null,
  set: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('~/lib/queries', () => ({
  useExpectedIncome: () => ({ data: { amount: state.override }, isPending: false, isError: false }),
  useSetExpectedIncome: () => ({ mutate: state.set }),
  useClearExpectedIncome: () => ({ mutate: state.clear }),
}));

import { ExpectedIncome } from '../ExpectedIncome';

function renderIt(regular: number | null) {
  render(<MantineProvider><ExpectedIncome regular={regular} /></MantineProvider>);
  return userEvent.setup();
}

beforeEach(() => {
  state.override = null;
  state.set.mockReset();
  state.clear.mockReset();
});

describe('ExpectedIncome', () => {
  it('shows "Set your own" and no figure when nothing is known', () => {
    renderIt(null);
    expect(screen.getByText('Not enough history yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set your own' })).toBeTruthy();
    expect(screen.queryByText(/£/)).toBeNull();
  });

  it('shows the history source when there is no override', () => {
    renderIt(200000);
    expect(screen.getByText('Average of your last 3 months')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use my usual' })).toBeNull();
  });

  it('shows the override and "Set by you"', () => {
    state.override = 250000;
    renderIt(200000);
    expect(screen.getByText('Set by you')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Expected income' })).toHaveProperty('value', '2500.00');
  });

  it('saves a typed amount in pence', async () => {
    const user = renderIt(null);
    await user.type(screen.getByRole('textbox', { name: 'Expected income' }), '1800');
    await user.click(screen.getByRole('button', { name: 'Set your own' }));
    expect(state.set.mock.calls[0][0]).toBe(180000);
  });

  it('clearing calls the clear mutation', async () => {
    state.override = 250000;
    const user = renderIt(200000);
    await user.click(screen.getByRole('button', { name: 'Use my usual' }));
    expect(state.clear).toHaveBeenCalledTimes(1);
  });
});
