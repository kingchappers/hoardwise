import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import type { PotSummary } from '~/lib/types';

const state = vi.hoisted(() => ({ save: vi.fn(), fail: false }));

vi.mock('~/lib/queries', () => ({
  useSavePot: () => ({
    mutate: (vars: unknown, callbacks: { onSuccess?: () => void; onError?: (e: Error) => void }) => {
      state.save(vars);
      if (state.fail) callbacks.onError?.(new Error('boom'));
      else callbacks.onSuccess?.();
    },
  }),
}));

import { PotPlanField } from '../PotPlanField';
import { PlanDraftProvider, usePlanDrafts } from '~/components/plan/PlanDraftContext';

function pot(overrides: Partial<PotSummary> = {}): PotSummary {
  return {
    categoryId: 'holiday', monthlyAmount: 10000, goalAmount: 50000, autoAmountNow: 0, balance: 0,
    thisMonth: { setAside: 0, autoAdded: 0, takeOut: 0, spent: 0 }, months: [], ...overrides,
  };
}

function Drafts() {
  const { drafts } = usePlanDrafts();
  return <output data-testid="drafts">{JSON.stringify(drafts)}</output>;
}

function Host({ show, p = pot() }: { show: boolean; p?: PotSummary }) {
  return (
    <MantineProvider>
      <PlanDraftProvider>
        {show && <PotPlanField pot={p} />}
        <Drafts />
      </PlanDraftProvider>
    </MantineProvider>
  );
}

function renderField(p: PotSummary = pot()) {
  const result = render(<Host show p={p} />);
  return { ...result, user: userEvent.setup() };
}

beforeEach(() => {
  state.save.mockReset();
  state.fail = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('PotPlanField', () => {
  it('starts with the saved amount and records a draft as you type', async () => {
    const { user } = renderField();
    const field = screen.getByLabelText('Planned per month');
    expect(field).toHaveValue('100.00');
    await user.clear(field);
    await user.type(field, '25');
    expect(screen.getByTestId('drafts')).toHaveTextContent('{"holiday":2500}');
  });

  it('saves the monthly amount with the pot goal and clears the draft once the saved amount arrives', async () => {
    const { user, rerender } = renderField();
    const field = screen.getByLabelText('Planned per month');
    await user.clear(field);
    await user.type(field, '25');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(state.save).toHaveBeenCalledWith(
      {
        categoryId: 'holiday',
        input: { monthlyAmount: 2500, goalAmount: 50000, autoContribute: false, month: expect.stringMatching(/^\d{4}-\d{2}$/) },
      },
    );
    expect(screen.getByTestId('drafts')).toHaveTextContent('{"holiday":2500}');
    rerender(<Host show p={pot({ monthlyAmount: 2500 })} />);
    expect(screen.getByTestId('drafts')).toHaveTextContent('{}');
  });

  it('keeps automatic contributions on when the pot has them', async () => {
    const { user } = renderField(pot({ autoAmountNow: 10000 }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(state.save.mock.calls[0][0].input.autoContribute).toBe(true);
  });

  it('shows an error and no draft for an amount it cannot read', async () => {
    const { user } = renderField();
    const field = screen.getByLabelText('Planned per month');
    await user.clear(field);
    await user.type(field, 'abc');
    expect(field).toBeInvalid();
    expect(screen.getByTestId('drafts')).toHaveTextContent('{}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(state.save).not.toHaveBeenCalled();
  });

  it('says so when saving fails', async () => {
    state.fail = true;
    const { user } = renderField();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });

  it('drops its draft when it goes away', async () => {
    const { user, rerender } = renderField();
    const field = screen.getByLabelText('Planned per month');
    await user.clear(field);
    await user.type(field, '9');
    expect(screen.getByTestId('drafts')).toHaveTextContent('{"holiday":900}');
    rerender(<Host show={false} />);
    expect(screen.getByTestId('drafts')).toHaveTextContent('{}');
  });
});
