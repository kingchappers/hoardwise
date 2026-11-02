import { useEffect, useState } from 'react';
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { usePlanDrafts } from '~/components/plan/PlanDraftContext';
import { SaveStatus, type SaveState } from '~/components/layout/SaveStatus';
import { TermHelp } from '~/components/layout/TermHelp';
import { formatPencePlain, parseOptionalPounds } from '~/lib/money';
import { currentYearMonth } from '~/lib/months';
import { useSavePot } from '~/lib/queries';
import type { PotSummary } from '~/lib/types';

export function PotPlanField({ pot, name }: { pot: PotSummary; name?: string }) {
  const { setDraft, clearDraft } = usePlanDrafts();
  const save = useSavePot();
  const [value, setValue] = useState(pot.monthlyAmount !== null ? formatPencePlain(pot.monthlyAmount) : '');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const categoryId = pot.categoryId;

  useEffect(() => () => clearDraft(categoryId), [categoryId, clearDraft]);

  const parsed = parseOptionalPounds(value);
  const error = parsed.ok ? null : parsed.message;

  function change(next: string): void {
    setValue(next);
    setSaveState('idle');
    const result = parseOptionalPounds(next);
    if (result.ok) setDraft(categoryId, result.pence);
    else clearDraft(categoryId);
  }

  function send(): void {
    const result = parseOptionalPounds(value);
    if (!result.ok) return;
    setSaveState('saving');
    save.mutate(
      {
        categoryId,
        input: {
          monthlyAmount: result.pence,
          goalAmount: pot.goalAmount,
          autoContribute: pot.autoAmountNow > 0 && result.pence !== null,
          month: currentYearMonth(),
        },
      },
      {
        onSuccess: () => {
          setSaveState('saved');
          clearDraft(categoryId);
        },
        onError: (saveError: Error) => {
          console.error(`Failed to save the planned amount for pot ${categoryId}:`, saveError);
          setSaveState('error');
        },
      },
    );
  }

  return (
    <Stack gap={4} mt="sm">
      <Group align="flex-end" wrap="nowrap" gap="xs">
        <Group align="flex-end" wrap="nowrap" gap={0} style={{ flex: 1 }}>
          <TextInput
            label="Planned per month" placeholder="0.00" inputMode="decimal"
            style={{ flex: 1, minWidth: 100 }} styles={{ input: { minHeight: 44 } }}
            value={value} onChange={e => change(e.currentTarget.value)} error={error}
          />
          <TermHelp terms={['monthlyAmount']} />
        </Group>
        <Button
          onClick={send} loading={saveState === 'saving'} disabled={error !== null}
          style={{ minHeight: 44 }}
          aria-label={name ? `Save planned amount for ${name}` : undefined}
        >
          Save
        </Button>
      </Group>
      {pot.autoAmountNow > 0 && (
        <Text size="sm" c="dimmed">Automatic contributions are on, so saving keeps adding the new amount every month.</Text>
      )}
      <Group justify="flex-end" mih={24}>
        <SaveStatus state={saveState} onRetry={send} />
      </Group>
    </Stack>
  );
}
