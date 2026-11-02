import { Badge, Button, Card, Group, Progress, Stack, Text, UnstyledButton, VisuallyHidden } from '@mantine/core';
import { GLOSSARY } from '~/lib/glossary';
import { categoryLabel } from '~/lib/categoryIcons';
import { formatPence } from '~/lib/money';
import { goalPercent, thisMonthSummary } from '~/lib/pots';
import type { Category, PotSummary } from '~/lib/types';
import { PotPlanField } from './PotPlanField';

export interface PotRowProps {
  pot: PotSummary;
  category: Category;
  onSetAside?: () => void;
  onOpen?: () => void;
}

function formatBalance(pence: number): string {
  return pence < 0 ? `−${formatPence(-pence)}` : formatPence(pence);
}

export function PotRow({ pot, category, onSetAside, onOpen }: PotRowProps) {
  const percent = goalPercent(pot.balance, pot.goalAmount);
  const activity = thisMonthSummary(pot);
  const name = categoryLabel(category);

  const details = (
    <Stack gap={4}>
      <Group gap="xs" wrap="wrap">
        <Text fw={500}>{name}</Text>
        {pot.autoAmountNow > 0 && <Badge size="lg" variant="light">Auto {formatPence(pot.autoAmountNow)} a month</Badge>}
        {pot.balance < 0 && <Badge size="lg" variant="light" color="ember">Below zero</Badge>}
      </Group>
      <Text fw={700} size="lg" c={pot.balance < 0 ? 'ember' : undefined}>{formatBalance(pot.balance)}</Text>
      {pot.goalAmount !== null && (
        <>
          <Progress value={percent ?? 0} aria-label={`${category.name} goal progress`} />
          <Text size="sm">{formatPence(Math.max(0, pot.balance))} of {formatPence(pot.goalAmount)}</Text>
        </>
      )}
      {activity && <Text size="sm">{activity}</Text>}
    </Stack>
  );

  return (
    <Card withBorder mb="xs">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        {onOpen
          ? (
            // No aria-label: it would replace the balance, badges and progress inside. The hidden text adds to them instead.
            <UnstyledButton onClick={onOpen} style={{ flex: 1, minWidth: 0 }}>
              {details}
              <VisuallyHidden>Open {category.name} history</VisuallyHidden>
            </UnstyledButton>
          )
          : <div style={{ flex: 1, minWidth: 0 }}>{details}</div>}
        {onSetAside && (
          <Button size="compact-sm" variant="light" onClick={onSetAside} aria-label={`Add to ${category.name} pot`}>
            {GLOSSARY.setAside.term}
          </Button>
        )}
      </Group>
      {!pot.archivedAt && <PotPlanField pot={pot} name={category.name} />}
    </Card>
  );
}
