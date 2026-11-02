import { Link } from 'react-router';
import { Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { formatPence } from '~/lib/money';
import { currentYearMonth } from '~/lib/months';
import { leftToSpendSentence, type MonthSummary } from '~/lib/summary';
import type { MonthFigures } from '../../../src/shared/monthFigures';
import { OutgoingsBar } from './OutgoingsBar';

const FIGURES_FAILED = "We couldn't load your put-away figures. Nothing has been lost.";
const FIGURES_LOADING = 'Loading your figures…';
const ACTUALLY_SPENT_EXPLAINER = "Money that left your accounts: your expenses plus spending paid out of pots. Pot spending comes out of what you put away earlier, so it isn't added to 'Spent + put away'.";

interface HomeSummaryProps {
  summary: MonthSummary;
  figures: MonthFigures | null;
  figuresFailed?: boolean;
  yearMonth: string;
}

export function HomeSummary({ summary, figures, figuresFailed = false, yearMonth }: HomeSummaryProps) {
  const sentence = leftToSpendSentence(summary, yearMonth);
  return (
    <Stack gap="xs">
      {sentence && <Text size="lg" fw={600}>{sentence}</Text>}
      {sentence && (
        <Text size="sm" mt={-4}>
          {summary.spentUnbudgeted > 0
            ? `This counts only categories with a budget. ${formatPence(summary.spentUnbudgeted)} of other spending is not included.`
            : 'This counts only categories with a budget.'}
        </Text>
      )}
      {figures ? (
        <OutgoingsBar
          incomeLabel="Income"
          incomePence={figures.income}
          incomeNoun="your income"
          partsLabel="Where it went"
          parts={[
            { label: 'Expenses', pence: figures.expensesOutsidePots },
            { label: 'Put into pots', pence: figures.putIntoPots + figures.unfundedPotSpending },
          ]}
          totalLabel="Spent + put away"
          secondary={{ label: 'Actually spent', pence: figures.actuallySpent, explainer: ACTUALLY_SPENT_EXPLAINER }}
        />
      ) : (
        <Text size="sm">{figuresFailed ? FIGURES_FAILED : FIGURES_LOADING}</Text>
      )}
      {summary.incomeTotal === 0 && yearMonth === currentYearMonth() && (
        <Text size="sm">No income recorded yet this month.</Text>
      )}
    </Stack>
  );
}

export function OtherSpendingRow({ amount, yearMonth }: { amount: number; yearMonth: string }) {
  return (
    <UnstyledButton
      component={Link}
      to={`/transactions?month=${yearMonth}&spending=untargeted`}
      display="block"
      py={4}
      style={{ borderRadius: 'var(--mantine-radius-sm)' }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Text fw={500}>Other spending (no budget)</Text>
        <Group gap={4} wrap="nowrap">
          <Text fw={600}>{formatPence(amount)}</Text>
          <IconChevronRight size={16} aria-hidden color="var(--mantine-color-dimmed)" />
        </Group>
      </Group>
    </UnstyledButton>
  );
}
