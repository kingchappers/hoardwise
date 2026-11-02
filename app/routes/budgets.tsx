import { useEffect, useState } from 'react';
import { ActionIcon, Button, Card, Group, Input, Loader, Menu, SegmentedControl, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconDots, IconTrash } from '@tabler/icons-react';
import { LoadError } from '~/components/layout/LoadError';
import { DefaultLayout } from '~/components/layout/DefaultLayout';
import { SaveStatus, type SaveState } from '~/components/layout/SaveStatus';
import { useUndoableDelete } from '~/hooks/useUndoableDelete';
import { categoryLabel } from '~/lib/categoryIcons';
import { groupCategories } from '~/lib/categoryGroups';
import { formatPencePlain, parsePounds } from '~/lib/money';
import { targetLabel } from '~/lib/trash';
import { useCategories, useDeleteTarget, useSetTarget, useTargets } from '~/lib/queries';
import { NAMES } from '~/lib/glossary';
import { TermHelp } from '~/components/layout/TermHelp';
import type { Category, TargetPeriod } from '~/lib/types';
import { pageTitle } from '~/lib/pageTitle';
import type { Route } from './+types/budgets';
import { redirect } from 'react-router';
import { planPath } from '~/lib/planTabs';

function isDirty(value: string, period: TargetPeriod, savedPence: number | null, savedPeriod: TargetPeriod): boolean {
  if (period !== savedPeriod) return true;
  const parsed = parsePounds(value);
  if (!parsed.ok) return value.trim() !== '' || savedPence !== null;
  return parsed.pence !== savedPence;
}

function TargetRow({ category, amountPence, period }: {
  category: Category;
  amountPence: number | null;
  period: TargetPeriod;
}) {
  const [value, setValue] = useState(amountPence !== null ? formatPencePlain(amountPence) : '');
  const [selectedPeriod, setSelectedPeriod] = useState<TargetPeriod>(period);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const setTarget = useSetTarget();
  const removeTarget = useDeleteTarget();
  const undoableDelete = useUndoableDelete();

  // The saved target changes on save, remove, undo and a failed remove;
  // the inputs follow it so an Undo puts the amount back in the box.
  useEffect(() => {
    setValue(amountPence !== null ? formatPencePlain(amountPence) : '');
    setSelectedPeriod(period);
  }, [amountPence, period]);

  function remove(targetAmount: number): void {
    undoableDelete({
      label: targetLabel(targetAmount, category.name),
      name: `the ${category.name} budget`,
      ref: { entityType: 'TARGET', id: category.categoryId },
      run: () => removeTarget.mutateAsync(category.categoryId),
    });
  }

  const unsaved = saveState === 'idle' && isDirty(value, selectedPeriod, amountPence, period);

  function save(): void {
    const parsed = parsePounds(value);
    if (!parsed.ok) { setError(parsed.message); return; }
    setError(null);
    setSaveState('saving');
    setTarget.mutate(
      { categoryId: category.categoryId, targetAmount: parsed.pence, period: selectedPeriod },
      {
        onSuccess: () => setSaveState('saved'),
        onError: (saveError: Error) => {
          console.error(`Failed to save the budget for category ${category.categoryId}:`, saveError);
          setSaveState('error');
        },
      },
    );
  }

  function changeValue(next: string): void {
    setValue(next);
    setSaveState('idle');
  }

  function changePeriod(next: TargetPeriod): void {
    setSelectedPeriod(next);
    setSaveState('idle');
  }

  return (
    <Card withBorder mb="xs">
      <Group justify="space-between" mb="xs">
        <Text fw={500}>{categoryLabel(category)}</Text>
        {amountPence !== null && (
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" aria-label={`Actions for ${category.name} budget`}><IconDots size={16} /></ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconTrash size={14} />} onClick={() => remove(amountPence)}>Remove budget</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      <Group align="flex-end">
        <TextInput
          label="Budget" placeholder="0.00" inputMode="decimal" style={{ flex: 1, minWidth: 100 }}
          value={value} onChange={e => changeValue(e.currentTarget.value)} error={error}
          aria-label={`Budget for ${category.name}`}
        />
        <Input.Wrapper label="Repeats">
          <SegmentedControl
            mt={4}
            aria-label={`How often the ${category.name} budget repeats`}
            value={selectedPeriod}
            onChange={v => changePeriod(v as TargetPeriod)}
            data={[{ label: 'per month', value: 'MONTHLY' }, { label: 'per week', value: 'WEEKLY' }]}
          />
        </Input.Wrapper>
        <Button onClick={save} loading={saveState === 'saving'}>Save</Button>
      </Group>
      <Group justify="flex-end" mt={4} mih={24}>
        {unsaved && <Text size="sm">Not saved yet</Text>}
        <SaveStatus state={saveState} onRetry={save} />
      </Group>
    </Card>
  );
}

export function BudgetsContent() {
  const categories = useCategories();
  const targets = useTargets();

  if (categories.error || targets.error) {
    return (
      <LoadError thing="budgets" onRetry={() => { categories.refetch(); targets.refetch(); }} />
    );
  }
  if (categories.isLoading || targets.isLoading) {
    return <Group justify="center" py="xl"><Loader /></Group>;
  }

  const targetFor = (id: string) => targets.data?.find(t => t.categoryId === id);
  const eligible = (categories.data ?? []).filter(c => c.type === 'EXPENSE');

  return (
    <Stack>
      <Group gap={0}>
        <Title order={2} size="h4">{NAMES.budgets}</Title>
        <TermHelp terms={['target']} />
      </Group>
      <Text c="dimmed" size="sm">{NAMES.budgetsAreOptional} Income and pots have no monthly budget here. Set a pot goal and plan on the Pots page.</Text>

      {groupCategories(eligible).map(bucket => (
        <div key={bucket.key}>
          <Title order={3} size="h5" mt="md" mb="xs">{bucket.label}</Title>
          {bucket.items.map(c => {
            const t = targetFor(c.categoryId);
            return <TargetRow key={c.categoryId} category={c}
              amountPence={t?.targetAmount ?? null} period={t?.period ?? 'MONTHLY'} />;
          })}
        </div>
      ))}
    </Stack>
  );
}

// This page now lives under Plan. The old address still works and leads there.
export function clientLoader({ request }: Route.ClientLoaderArgs) {
  throw redirect(planPath('budgets', new URL(request.url).search));
}

export const meta: Route.MetaFunction = () => [{ title: pageTitle(NAMES.budgets) }];

export default function Budgets() {
  return (
    <DefaultLayout>
      <BudgetsContent />
    </DefaultLayout>
  );
}
