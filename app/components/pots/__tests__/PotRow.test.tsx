import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { theme } from '~/root';
vi.mock('~/lib/queries', () => ({ useSavePot: () => ({ mutate: vi.fn() }) }));

import { PotRow } from '../PotRow';
import type { Category, PotSummary } from '~/lib/types';

const category: Category = { categoryId: 'a', name: 'Holidays', type: 'POT', group: 'SINKING_FUNDS', icon: '✈️', isDefault: true, createdAt: '' };

function pot(balance: number): PotSummary {
  return {
    categoryId: 'a', monthlyAmount: null, goalAmount: null, autoAmountNow: 0, balance,
    thisMonth: { setAside: 0, autoAdded: 0, takeOut: 0, spent: 0 }, months: [],
  };
}

function renderRow(balance: number) {
  return render(
    <MantineProvider theme={theme}>
      <PotRow pot={pot(balance)} category={category} onSetAside={vi.fn()} />
    </MantineProvider>,
  );
}

describe('PotRow below zero', () => {
  it('says so in words and uses the attention colour, never danger', () => {
    const { container } = renderRow(-1200);
    expect(screen.getByText('Below zero')).toBeInTheDocument();
    expect(screen.getByText('−£12.00')).toHaveStyle({ color: 'var(--mantine-color-ember-text)' });
    const card = container.querySelector('.mantine-Card-root') as HTMLElement;
    expect(card.innerHTML).not.toMatch(/danger/);
  });

  it('shows nothing extra for a pot in credit', () => {
    renderRow(5000);
    expect(screen.queryByText('Below zero')).not.toBeInTheDocument();
  });
});

describe('PotRow without an add action', () => {
  it('leaves out the Add to pot button, for an archived pot', () => {
    render(
      <MantineProvider theme={theme}>
        <PotRow pot={pot(0)} category={category} onOpen={vi.fn()} />
      </MantineProvider>,
    );
    expect(screen.queryByRole('button', { name: /Add to Holidays pot/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open Holidays history/ })).toBeInTheDocument();
  });
});
