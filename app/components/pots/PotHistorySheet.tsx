import { TermHelp } from '~/components/layout/TermHelp';
import { useState } from 'react';
import { ActionIcon, Alert, Button, Group, Stack, Switch, Table, Text, TextInput, UnstyledButton } from '@mantine/core';
import { RenameField } from '~/components/categories/RenameField';
import { IconPencil } from '@tabler/icons-react';
import { SaveStatus, type SaveState } from '~/components/layout/SaveStatus';
import { ResponsiveSheet } from '~/components/layout/ResponsiveSheet';
import { useInlineCategoryRename } from '~/hooks/useInlineCategoryRename';
import { NAMES } from '~/lib/glossary';
import { categoryLabel } from '~/lib/categoryIcons';
import { formatPence, formatPencePlain, parseOptionalPounds } from '~/lib/money';
import { currentYearMonth, formatMonthLabel } from '~/lib/months';
import { useSavePot } from '~/lib/queries';
import type { Category, PotSummary } from '~/lib/types';
import { ArchivePotSection } from './ArchivePotSection';
import { PotTrend } from './PotTrend';

export { parseOptionalPounds };

function formatBalance(pence: number): string {
  return pence < 0 ? `−${formatPence(-pence)}` : formatPence(pence);
}

function setAsideCell(setAside: number, autoAdded: number): string {
  const total = formatPence(setAside + autoAdded);
  return autoAdded > 0 ? `${total} (${formatPence(autoAdded)} auto)` : total;
}

function initialMonthly(pot: PotSummary, suggested: number | undefined): string {
  if (suggested !== undefined) return formatPencePlain(suggested);
  return pot.monthlyAmount !== null ? formatPencePlain(pot.monthlyAmount) : '';
}

function PotSettingsForm({ pot, category, suggestedMonthly }: {
  pot: PotSummary;
  category: Category | undefined;
  suggestedMonthly?: number;
}) {
  const save = useSavePot();
  const [monthly, setMonthly] = useState(initialMonthly(pot, suggestedMonthly));
  const [goal, setGoal] = useState(pot.goalAmount !== null ? formatPencePlain(pot.goalAmount) : '');
  const [auto, setAuto] = useState(pot.autoAmountNow > 0);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const rename = useInlineCategoryRename(category, setError);

  const parsedMonthly = parseOptionalPounds(monthly);
  const hasMonthly = parsedMonthly.ok && parsedMonthly.pence !== null;

  function send(): void {
    const monthlyResult = parseOptionalPounds(monthly);
    const goalResult = parseOptionalPounds(goal);
    if (!monthlyResult.ok) { setError(monthlyResult.message); return; }
    if (!goalResult.ok) { setError(goalResult.message); return; }
    setError(null);
    setSaveState('saving');
    save.mutate(
      {
        categoryId: pot.categoryId,
        input: {
          monthlyAmount: monthlyResult.pence,
          goalAmount: goalResult.pence,
          autoContribute: auto && monthlyResult.pence !== null,
          month: currentYearMonth(),
        },
      },
      {
        onSuccess: () => setSaveState('saved'),
        onError: (saveError: Error) => {
          console.error(`Failed to save settings for pot ${pot.categoryId}:`, saveError);
          setSaveState('error');
        },
      },
    );
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    send();
  }

  return (
    <form onSubmit={submit}>
      <Stack gap="sm">
        <Text fw={600}>Settings</Text>
        {category && !category.isDefault && (
          rename.editing ? (
            <RenameField
              categoryName={category.name}
              draft={rename.draft}
              onDraftChange={rename.setDraft}
              onSave={rename.commit}
              onCancel={rename.cancel}
            />
          ) : (
            <Group gap={4}>
              <UnstyledButton onClick={rename.start}>
                <Text size="sm" c="dimmed">{categoryLabel(category)}</Text>
              </UnstyledButton>
              <ActionIcon size="xs" variant="subtle" aria-label={`Rename ${category.name}`} onClick={rename.start}>
                <IconPencil size={12} />
              </ActionIcon>
            </Group>
          )
        )}
        <Group align="flex-end" wrap="nowrap" gap={0}>
          <TextInput label="Monthly amount" placeholder="0.00" inputMode="decimal" value={monthly} style={{ flex: 1 }}
            onChange={e => { setMonthly(e.currentTarget.value); setSaveState('idle'); }} />
          <TermHelp terms={['monthlyAmount']} />
        </Group>
        <Group align="flex-end" wrap="nowrap" gap={0}>
          <TextInput label={NAMES.potGoal} placeholder="0.00" inputMode="decimal" value={goal} style={{ flex: 1 }}
            onChange={e => { setGoal(e.currentTarget.value); setSaveState('idle'); }} />
          <TermHelp terms={['potGoal']} />
        </Group>
        <Group wrap="nowrap" gap={0}>
          <Switch
            label="Auto-contribute"
            description={hasMonthly ? 'Adds the monthly amount every month, from this month.' : 'Set a monthly amount first.'}
            checked={auto && hasMonthly}
            disabled={!hasMonthly}
            onChange={e => { setAuto(e.currentTarget.checked); setSaveState('idle'); }}
            style={{ flex: 1 }}
          />
          <TermHelp terms={['autoContribute']} />
        </Group>
        {error && <Alert color="danger" role="alert">{error}</Alert>}
        <Group justify="flex-end">
          <SaveStatus state={saveState} onRetry={send} />
          <Button type="submit" loading={saveState === 'saving'}>Save</Button>
        </Group>
      </Stack>
    </form>
  );
}

export interface PotHistorySheetProps {
  pot: PotSummary | null;
  category: Category | undefined;
  // A monthly amount to fill in, not yet saved, e.g. from a yearly bill.
  suggestedMonthly?: number;
  onClose: () => void;
}

export function PotHistorySheet({ pot, category, suggestedMonthly, onClose }: PotHistorySheetProps) {
  const title = category ? categoryLabel(category) : 'Pot';
  const months = pot ? [...pot.months].reverse() : [];

  return (
    <ResponsiveSheet opened={pot !== null} onClose={onClose} title={title}>
      {pot && (
        <Stack gap="md">
          <div>
            <Text size="sm">Balance</Text>
            <Text fw={700} size="xl" c={pot.balance < 0 ? 'ember' : undefined}>{formatBalance(pot.balance)}</Text>
          </div>
          <PotTrend values={pot.months.map(m => m.closing)} />
          {months.length === 0 ? (
            <Text c="dimmed" size="sm">No activity yet.</Text>
          ) : (
            <Table.ScrollContainer minWidth={420}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Month</Table.Th>
                    <Table.Th>Opening</Table.Th>
                    <Table.Th>Added to pot</Table.Th>
                    <Table.Th>Taken out</Table.Th>
                    <Table.Th>Spent</Table.Th>
                    <Table.Th>Closing</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {months.map(m => (
                    <Table.Tr key={m.yearMonth}>
                      <Table.Td>{formatMonthLabel(m.yearMonth)}</Table.Td>
                      <Table.Td>{formatBalance(m.opening)}</Table.Td>
                      <Table.Td>{setAsideCell(m.setAside, m.autoAdded)}</Table.Td>
                      <Table.Td>{formatPence(m.takeOut)}</Table.Td>
                      <Table.Td>{formatPence(m.spent)}</Table.Td>
                      <Table.Td>{formatBalance(m.closing)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          {!pot.archivedAt && (
            <PotSettingsForm key={pot.categoryId} pot={pot} category={category} suggestedMonthly={suggestedMonthly} />
          )}
          <ArchivePotSection key={`archive-${pot.categoryId}`} pot={pot} category={category} onDone={onClose} />
        </Stack>
      )}
    </ResponsiveSheet>
  );
}
