import { useEffect, useState } from 'react';
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { LoadError } from '~/components/layout/LoadError';
import { SaveStatus, type SaveState } from '~/components/layout/SaveStatus';
import { formatPencePlain, parsePounds } from '~/lib/money';
import { useClearExpectedIncome, useExpectedIncome, useSetExpectedIncome } from '~/lib/queries';

export type HistoryStatus = 'ready' | 'loading' | 'error';

function sourceLine(override: number | null, regular: number | null, history: HistoryStatus): string {
  if (override !== null) return 'Set by you';
  if (regular !== null) return 'Average of your last 3 months';
  if (history === 'loading') return 'Working out your usual income…';
  if (history === 'error') return "We couldn't load your income history.";
  return 'Not enough history yet';
}

export function ExpectedIncome({ regular, history = 'ready' }: { regular: number | null; history?: HistoryStatus }) {
  const { data, isPending, isError, refetch } = useExpectedIncome();
  const override = data?.amount ?? null;
  const [value, setValue] = useState(override !== null ? formatPencePlain(override) : '');
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastAction, setLastAction] = useState<'save' | 'clear'>('save');
  const setIncome = useSetExpectedIncome();
  const clearIncome = useClearExpectedIncome();

  useEffect(() => {
    setValue(override !== null ? formatPencePlain(override) : '');
  }, [override]);

  function save(): void {
    const parsed = parsePounds(value);
    if (!parsed.ok) { setError(parsed.message); return; }
    setError(null);
    setLastAction('save');
    setSaveState('saving');
    setIncome.mutate(parsed.pence, {
      onSuccess: () => setSaveState('saved'),
      onError: (saveError: Error) => {
        console.error(`Failed to save expected income of ${parsed.pence} pence:`, saveError);
        setSaveState('error');
      },
    });
  }

  function clear(): void {
    setError(null);
    setLastAction('clear');
    setSaveState('saving');
    clearIncome.mutate(undefined, {
      onSuccess: () => setSaveState('idle'),
      onError: (clearError: Error) => {
        console.error('Failed to clear expected income:', clearError);
        setSaveState('error');
      },
    });
  }

  function changeValue(next: string): void {
    setValue(next);
    setSaveState('idle');
  }

  if (isPending) return <Text size="sm">Loading your expected income…</Text>;
  if (isError) return <LoadError thing="expected income" onRetry={() => { void refetch(); }} />;

  return (
    <Stack gap="xs">
      <Text size="sm">{sourceLine(override, regular, history)}</Text>
      <Group align="flex-end" gap="sm">
        <TextInput
          aria-label="Expected income" placeholder="0.00" inputMode="decimal"
          style={{ flex: 1, minWidth: 100 }} styles={{ input: { minHeight: 44 } }}
          value={value} onChange={(e) => changeValue(e.currentTarget.value)} error={error}
        />
        <Button onClick={save} loading={saveState === 'saving'} style={{ minHeight: 44 }}>Set your own</Button>
        {override !== null && (
          <Button variant="default" onClick={clear} style={{ minHeight: 44 }}>Use my usual</Button>
        )}
      </Group>
      <Group justify="flex-end" mih={24}>
        <SaveStatus state={saveState} onRetry={lastAction === 'clear' ? clear : save} />
      </Group>
    </Stack>
  );
}
