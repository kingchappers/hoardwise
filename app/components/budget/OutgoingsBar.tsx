import { Box, Divider, Group, Stack, Text } from '@mantine/core';
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react';
import { formatPence } from '~/lib/money';

export interface OutgoingsBarProps {
  incomeLabel: string;
  incomePence: number | null;
  incomeNoun: string;
  partsLabel: string;
  parts: { label: string; pence: number }[];
  totalLabel: string;
  note?: string;
  secondary?: { label: string; pence: number; explainer: string };
}

const PART_FILLS = ['var(--hw-hoard)', 'var(--hw-gold)'];
const BAR_HEIGHT = 22;

function widthPercent(pence: number, scale: number): string {
  if (scale <= 0) return '0%';
  return `${Math.round((pence / scale) * 1000) / 10}%`;
}

function Bar({ width, testId, children }: { width: string; testId: string; children?: React.ReactNode }) {
  return (
    <Box
      data-testid={testId}
      style={{
        display: 'flex',
        height: BAR_HEIGHT,
        width,
        borderRadius: 'var(--mantine-radius-sm)',
        overflow: 'hidden',
      }}
    >
      {children}
    </Box>
  );
}

function ComparisonLine({ difference, incomeNoun }: { difference: number; incomeNoun: string }) {
  const over = difference > 0;
  const Icon = over ? IconArrowUp : IconArrowDown;
  const text = over
    ? `${formatPence(difference)} more than ${incomeNoun}`
    : `${formatPence(-difference)} left after pots`;
  return (
    <Group gap={4} wrap="nowrap" data-tone={over ? 'over' : 'under'}>
      <Icon size={16} aria-hidden color={over ? 'var(--mantine-color-ember-text)' : 'var(--mantine-color-hoard-text)'} />
      <Text fw={600} c={over ? 'ember' : undefined}>{text}</Text>
    </Group>
  );
}

export function OutgoingsBar(props: OutgoingsBarProps) {
  const { incomePence, parts, secondary } = props;
  const partsTotal = parts.reduce((sum, p) => sum + p.pence, 0);
  const scale = Math.max(incomePence ?? 0, partsTotal);
  const partsSum = partsTotal || 1;
  const showComparison = incomePence !== null && incomePence > 0;

  return (
    <Stack gap="xs">
      <div>
        <Text size="sm" fw={600} mb={4}>{props.incomeLabel}</Text>
        <Bar width={widthPercent(incomePence ?? 0, scale)} testId="income-bar">
          <Box style={{ flex: 1, background: 'var(--mantine-color-default-border)' }} />
        </Bar>
        <Text fw={600} mt={2}>{incomePence === null ? 'Not set' : formatPence(incomePence)}</Text>
        {props.note && <Text size="sm" c="dimmed">{props.note}</Text>}
      </div>

      <div>
        <Text size="sm" fw={600} mb={4}>{props.partsLabel}</Text>
        <Bar width={widthPercent(partsTotal, scale)} testId="parts-bar">
          {parts.map((part, i) => (
            <Box
              key={part.label}
              style={{ width: widthPercent(part.pence, partsSum), background: PART_FILLS[i % PART_FILLS.length] }}
            />
          ))}
        </Bar>
        <Group gap="md" mt={6}>
          {parts.map((part, i) => (
            <Group key={part.label} gap={6} wrap="nowrap">
              <Box
                aria-hidden
                style={{ width: 12, height: 12, borderRadius: 2, background: PART_FILLS[i % PART_FILLS.length] }}
              />
              <Text size="sm">{part.label} {formatPence(part.pence)}</Text>
            </Group>
          ))}
        </Group>
      </div>

      <Text fw={700}>{props.totalLabel}: {formatPence(partsTotal)}</Text>
      {showComparison && <ComparisonLine difference={partsTotal - incomePence} incomeNoun={props.incomeNoun} />}

      {secondary && (
        <>
          <Divider my={4} />
          <Text fw={600}>{secondary.label}: {formatPence(secondary.pence)}</Text>
          <Text size="sm" c="dimmed">{secondary.explainer}</Text>
        </>
      )}
    </Stack>
  );
}
