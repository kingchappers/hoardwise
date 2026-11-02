import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('~/components/layout/DefaultLayout', () => ({
  DefaultLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/plan/PlanSummary', () => ({ PlanSummary: () => <div>Plan summary</div> }));
vi.mock('../budgets', () => ({ BudgetsContent: () => <div>Budgets content</div> }));
vi.mock('../pots', () => ({ PotsContent: () => <div>Pots content</div> }));
vi.mock('../recurring', () => ({ RecurringContent: () => <div>Recurring content</div> }));

import Plan from '../plan';

function Url() {
  const location = useLocation();
  return <output data-testid="url">{location.pathname + location.search}</output>;
}

function renderPlan(url = '/plan') {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[url]}>
        <Plan />
        <Url />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('Plan page', () => {
  it('has Budgets, Pots and Recurring as tabs, opening on Budgets', () => {
    renderPlan();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Budgets', 'Pots', 'Recurring']);
    expect(screen.getByRole('tab', { name: 'Budgets' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Budgets content')).toBeInTheDocument();
    expect(screen.queryByText('Pots content')).not.toBeInTheDocument();
  });

  it.each([
    ['pots', 'Pots content'],
    ['recurring', 'Recurring content'],
    ['budgets', 'Budgets content'],
  ])('opens the %s tab from the address', (tab, content) => {
    renderPlan(`/plan?tab=${tab}`);
    expect(screen.getByText(content)).toBeInTheDocument();
  });

  it('shows the plan summary above whichever tab is open', () => {
    renderPlan('/plan?tab=pots');
    expect(screen.getByText('Plan summary')).toBeInTheDocument();
  });

  it('falls back to Budgets for a tab it does not know', () => {
    renderPlan('/plan?tab=nonsense');
    expect(screen.getByText('Budgets content')).toBeInTheDocument();
  });

  it('changes tab and the address together', async () => {
    const user = userEvent.setup();
    renderPlan();

    await user.click(screen.getByRole('tab', { name: 'Recurring' }));

    expect(screen.getByText('Recurring content')).toBeInTheDocument();
    expect(screen.queryByText('Budgets content')).not.toBeInTheDocument();
    expect(screen.getByTestId('url')).toHaveTextContent('/plan?tab=recurring');
  });

  it('drops anything meant for the tab you left', async () => {
    const user = userEvent.setup();
    renderPlan('/plan?tab=pots&pot=holidays&monthly=3000');

    await user.click(screen.getByRole('tab', { name: 'Budgets' }));

    expect(screen.getByTestId('url')).toHaveTextContent('/plan?tab=budgets');
  });

  it('keeps the parameters while staying on the tab they are for', () => {
    renderPlan('/plan?tab=pots&pot=holidays&monthly=3000');
    expect(screen.getByTestId('url')).toHaveTextContent('/plan?tab=pots&pot=holidays&monthly=3000');
  });

  it('moves between tabs with the arrow keys', async () => {
    const user = userEvent.setup();
    renderPlan();
    screen.getByRole('tab', { name: 'Budgets' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Pots' })).toHaveFocus();
  });

  it('gives each tab a 44px target', () => {
    renderPlan();
    screen.getAllByRole('tab').forEach(tab => expect(tab).toHaveStyle({ minHeight: '44px' }));
  });

  it('names the page and the tab in the document title', () => {
    renderPlan('/plan?tab=pots');
    expect(document.title).toBe('Plan – Pots – Hoardwise');
  });

  it('still opens Budgets from an old ?tab=targets link', () => {
    renderPlan('/plan?tab=targets');
    expect(screen.getByText('Budgets content')).toBeInTheDocument();
  });
});
