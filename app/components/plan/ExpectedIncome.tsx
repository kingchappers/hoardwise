import { useEffect, useState } from 'react';
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { SaveStatus, type SaveState } from '~/components/layout/SaveStatus';
import { formatPencePlain, parsePounds } from '~/lib/money';
import { useClearExpectedIncome, useExpectedIncome, useSetExpectedIncome } from '~/lib/queries';

function sourceLine(override: number | null, regular: number | null): string {
  if (override !== null) return 'Set by you';
  if (regular !== null) return 'Average of your last 3 months';
  return 'Not enough history yet';
}

export function ExpectedIncome({ regular }: { regular: number | null }) {
  const { data } = useExpectedIncome();
  const override = data?.amount ?? null;
  const [value, setValue] = useState(override !== null ? formatPencePlain(override) : '');
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const setIncome = useSetExpectedIncome();
  const clearIncome = useClearExpectedIncome();

  useEffect(() => {
    setValue(override !== null ? formatPencePlain(override) : '');
  }, [override]);

  function save(): void {
    const parsed = parsePounds(value);
    if (!parsed.ok) { setError(parsed.message); return; }
    setError(null);
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

  return (
    <Stack gap="xs">
      <Text size="sm">{sourceLine(override, regular)}</Text>
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
        <SaveStatus state={saveState} onRetry={save} />
      </Group>
    </Stack>
  );
}
