import { Paper, Stack, Text } from '@mantine/core';
import { OutgoingsBar } from '~/components/budget/OutgoingsBar';
import { LoadError } from '~/components/layout/LoadError';
import { regularIncomeFromHistory } from '~/lib/expectedIncome';
import { currentYearMonth, shiftMonth } from '~/lib/months';
import { useCategories, useExpectedIncomeValue, usePots, useTargets, useTransactionsRange } from '~/lib/queries';
import { normaliseTargetToMonth } from '~/lib/summary';
import { plannedFigures } from '../../../src/shared/monthFigures';
import { ExpectedIncome } from './ExpectedIncome';
import { usePlanDrafts } from './PlanDraftContext';

const HISTORY_MONTHS = 6;
const POT_NOTE = "Spending you expect to do from a pot is counted inside that pot's planned amount, not on top of it.";

function PlanBody() {
  const month = currentYearMonth();
  const categories = useCategories();
  const targets = useTargets();
  const pots = usePots(month);
  const history = useTransactionsRange(shiftMonth(month, -HISTORY_MONTHS), shiftMonth(month, -1));
  const { drafts } = usePlanDrafts();
  const regular = regularIncomeFromHistory(history.data ?? [], month);
  const income = useExpectedIncomeValue(regular);

  if (categories.isError || targets.isError || pots.isError) {
    return (
      <LoadError
        thing="plan"
        onRetry={() => { void categories.refetch(); void targets.refetch(); void pots.refetch(); }}
      />
    );
  }
  if (!categories.data || !targets.data || !pots.data) {
    return <Text size="sm">Loading your plan…</Text>;
  }

  const expenseIds = new Set(categories.data.filter(c => c.type === 'EXPENSE').map(c => c.categoryId));
  const categoryTargetsMonthly = targets.data
    .filter(t => expenseIds.has(t.categoryId))
    .map(t => normaliseTargetToMonth(t.targetAmount, t.period, month));
  const potMonthlyAmounts = pots.data
    .filter(pot => !pot.archivedAt)
    .map(pot => (pot.categoryId in drafts ? drafts[pot.categoryId] : pot.monthlyAmount));
  const figures = plannedFigures({ categoryTargetsMonthly, potMonthlyAmounts });

  return (
    <Stack gap="sm">
      <OutgoingsBar
        incomeLabel="Expected income"
        incomePence={income}
        incomeNoun="expected income"
        partsLabel="What you've planned"
        parts={[
          { label: 'Budgeted spending', pence: figures.budgetedSpending },
          { label: 'Planned for pots', pence: figures.plannedForPots },
        ]}
        totalLabel="Total budgeted"
        note={POT_NOTE}
      />
      <ExpectedIncome regular={regular} />
    </Stack>
  );
}

export function PlanSummary() {
  return (
    <Paper withBorder p="md" data-testid="plan-summary">
      <PlanBody />
    </Paper>
  );
}
