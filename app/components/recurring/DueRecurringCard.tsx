import { useMemo, useRef, useState } from 'react';
import { ActionIcon, Anchor, Button, Card, Divider, Group, Menu, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { LoadError } from '~/components/layout/LoadError';
import { notifications } from '@mantine/notifications';
import { IconBellPause, IconDots, IconPencil, IconPlayerSkipForward } from '@tabler/icons-react';
import { useAuth } from '~/lib/auth';
import { Link } from 'react-router';
import { ToastAction } from '~/components/layout/ToastAction';
import { TransactionSheet } from '~/components/transactions/TransactionSheet';
import { useDueLink } from '~/hooks/useDueLink';
import { useDueRecurring } from '~/hooks/useDueRecurring';
import { useSaveWithUndo } from '~/hooks/useSaveWithUndo';
import { CategoryIcon } from '~/components/categories/CategoryIcon';
import { dismissMatch, isMatchDismissed, isSnoozed, snoozeUntilTomorrow } from '~/lib/billPrefs';
import { currentYearMonth, formatMonthName, formatShortDate, todayIso } from '~/lib/months';
import { usePreferences } from '~/lib/preferences';
import { useCategories, useLinkTransaction, useSetRecurringHandled } from '~/lib/queries';
import { undoAutoClose } from '~/lib/undoDuration';
import { dueLabel, groupDueItems, occurrenceLabel, olderGroupHeading, restorablePeriod, type DueGroup, type DueItem } from '~/lib/recurring';
import { formatPence } from '~/lib/money';
import { formatSignedPence } from '~/lib/transactionTypes';
import type { Transaction } from '~/lib/types';

function syntheticTransaction(item: DueItem): Transaction {
  const { recurring } = item;
  return {
    transactionId: `recurring-${recurring.recurringId}`,
    yearMonth: item.dueDate.slice(0, 7),
    amount: recurring.amount,
    type: recurring.type,
    categoryId: recurring.categoryId,
    description: recurring.description,
    date: item.dueDate,
    createdAt: '',
  };
}

interface DueRowProps {
  item: DueItem;
  label: string;
  icon: string;
  match: Transaction | null;
  onAdd: (item: DueItem) => void;
  onEdit: (item: DueItem) => void;
  onSkip: (item: DueItem) => void;
  onSnooze: (item: DueItem) => void;
  onConfirmMatch: (item: DueItem, match: Transaction) => void;
  onRejectMatch: (item: DueItem, match: Transaction) => void;
}

function DueRow({ item, label, icon, match, onAdd, onEdit, onSkip, onSnooze, onConfirmMatch, onRejectMatch }: DueRowProps) {
  return (
    <Stack gap={4} py={4}>
      <Group justify="space-between" wrap="wrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: '1 1 10rem' }}>
          <ThemeIcon variant="light" color="hoard" radius="xl" size={32}>
            <CategoryIcon icon={icon} />
          </ThemeIcon>
          <div style={{ minWidth: 0 }}>
            <Text truncate>{label}</Text>
            <Text size="sm">{dueLabel(item)}</Text>
          </div>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Text fw={500} style={{ whiteSpace: 'nowrap' }}>{formatSignedPence(item.recurring.type, item.recurring.amount)}</Text>
          <Button size="compact-sm" mih={44} aria-label={`Add ${label}`} onClick={() => onAdd(item)}>Add</Button>
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" size={44} aria-label={`More actions for ${label}`}><IconDots size={16} /></ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => onEdit(item)}>Add with changes</Menu.Item>
              <Menu.Item leftSection={<IconPlayerSkipForward size={14} />} onClick={() => onSkip(item)}>Didn't happen</Menu.Item>
              <Menu.Item leftSection={<IconBellPause size={14} />} onClick={() => onSnooze(item)}>Remind me tomorrow</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
      {match && (
        <Group role="group" aria-label={`Possible match for ${label}`} gap="xs" pl={44} wrap="wrap">
          <Text size="sm">{`Looks like you logged this on ${formatShortDate(match.date)}. Same thing?`}</Text>
          <Group gap="xs" wrap="nowrap">
            <Button size="compact-sm" variant="light" onClick={() => onConfirmMatch(item, match)}>Yes, that's it</Button>
            <Button size="compact-sm" variant="subtle" onClick={() => onRejectMatch(item, match)}>No</Button>
          </Group>
        </Group>
      )}
    </Stack>
  );
}

// Adding several old bills at once writes entries at the saved amounts, so it asks first and says how many and how much.
function AddAllButton({ group, onConfirm }: { group: DueGroup; onConfirm: (group: DueGroup) => void }) {
  const [confirming, setConfirming] = useState(false);
  const month = formatMonthName(group.period);
  const total = group.items.reduce((sum, item) => sum + item.recurring.amount, 0);
  if (!confirming) {
    return (
      <Button size="compact-sm" variant="light" aria-label={`Add all from ${month}`} onClick={() => setConfirming(true)}>
        Add all
      </Button>
    );
  }
  return (
    <Group gap="xs" wrap="wrap" justify="flex-end" role="group" aria-label={`Confirm adding all from ${month}`}>
      <Text size="sm">{`Add ${group.items.length} ${group.items.length === 1 ? 'bill' : 'bills'}, ${formatPence(total)} in all?`}</Text>
      <Button size="compact-sm" onClick={() => { setConfirming(false); onConfirm(group); }}>Yes, add them</Button>
      <Button size="compact-sm" variant="subtle" onClick={() => setConfirming(false)}>Cancel</Button>
    </Group>
  );
}

export function DueRecurringCard() {
  const { items, isLoading, error, refetch } = useDueRecurring();
  const { data: categories = [] } = useCategories();
  const userSub = useAuth().user?.sub ?? '';
  const [{ undoDuration, billReminders }] = usePreferences();
  const saveWithUndo = useSaveWithUndo();
  const setHandled = useSetRecurringHandled();
  const link = useLinkTransaction();
  const addingRef = useRef<Set<string>>(new Set());
  const [editing, setEditing] = useState<DueItem | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [, setPrefsVersion] = useState(0);
  const template = useMemo(() => (editing ? syntheticTransaction(editing) : null), [editing]);
  const today = todayIso();

  const visible = items.filter(item => !isSnoozed(userSub, item.recurring.recurringId, item.period, today));
  const groups = groupDueItems(visible, today);

  // Tapping Add or Skip on a reminder notification lands here.
  useDueLink(items, !isLoading && !error, { add, skip });

  function labelFor(item: DueItem): string {
    const category = categories.find(c => c.categoryId === item.recurring.categoryId);
    return item.recurring.description || category?.name || 'Recurring item';
  }

  function openMatch(item: DueItem): Transaction | null {
    const { recurringId } = item.recurring;
    return item.likelyMatches.find(t => !isMatchDismissed(userSub, recurringId, t.transactionId)) ?? null;
  }

  function markHandled(item: DueItem): void {
    setHandled.mutate({ recurringId: item.recurring.recurringId, period: item.period });
  }

  function add(item: DueItem): void {
    const { recurring, dueDate } = item;
    const inFlight = addingRef.current;
    if (inFlight.has(recurring.recurringId)) return;
    inFlight.add(recurring.recurringId);
    void saveWithUndo({
      amount: recurring.amount,
      type: recurring.type,
      categoryId: recurring.categoryId,
      description: recurring.description,
      date: dueDate,
      recurringId: recurring.recurringId,
    }).finally(() => { inFlight.delete(recurring.recurringId); });
  }

  function addAll(group: DueGroup): void {
    group.items.forEach(add);
  }

  function skip(item: DueItem): void {
    const { recurringId } = item.recurring;
    const previousPeriod = restorablePeriod(item.recurring);
    markHandled(item);

    const toastId = `skipped-${crypto.randomUUID()}`;
    notifications.show({
      id: toastId,
      autoClose: undoAutoClose(undoDuration),
      withCloseButton: true,
      closeButtonProps: { 'aria-label': 'Close notification' },
      message: (
        <ToastAction
          text={`Skipped ${labelFor(item)} for ${occurrenceLabel(item.period)}`}
          actionLabel="Undo"
          onAction={() => {
            notifications.hide(toastId);
            setHandled.mutate({ recurringId, period: previousPeriod });
          }}
        />
      ),
    });
  }

  function snooze(item: DueItem): void {
    snoozeUntilTomorrow(userSub, item.recurring.recurringId, item.period, today);
    setPrefsVersion(version => version + 1);
    notifications.show({ autoClose: undoAutoClose(undoDuration), message: `${labelFor(item)} will show again tomorrow` });
  }

  function confirmMatch(item: DueItem, match: Transaction): void {
    link.mutate({ transaction: match, recurringId: item.recurring.recurringId }, {
      onError: (linkError) => {
        console.error('Failed to link a transaction to its recurring bill:', linkError);
        notifications.show({
          autoClose: false,
          message: `Couldn't record ${labelFor(item)} as logged. Check your connection and try again.`,
        });
      },
    });
  }

  function rejectMatch(item: DueItem, match: Transaction): void {
    dismissMatch(userSub, item.recurring.recurringId, match.transactionId);
    setPrefsVersion(version => version + 1);
  }

  function renderRow(item: DueItem): React.ReactNode {
    return (
      <DueRow
        key={item.recurring.recurringId}
        item={item}
        label={labelFor(item)}
        icon={categories.find(c => c.categoryId === item.recurring.categoryId)?.icon ?? 'tag'}
        match={openMatch(item)}
        onAdd={add}
        onEdit={setEditing}
        onSkip={skip}
        onSnooze={snooze}
        onConfirmMatch={confirmMatch}
        onRejectMatch={rejectMatch}
      />
    );
  }

  let card: React.ReactNode = null;
  if (error) {
    card = (
      <LoadError thing="recurring items" onRetry={() => refetch()} />
    );
  } else if (!isLoading && visible.length > 0) {
    card = (
      <Card withBorder>
        <Group justify="space-between" mb="xs">
          <Title order={2} size="h5">Due</Title>
          <Anchor component={Link} to="/plan?tab=recurring" size="sm" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Manage</Anchor>
        </Group>
        {groups.current.map(renderRow)}
        {groups.older.length > 0 && (
          <>
            {groups.current.length > 0 && <Divider my="xs" />}
            <Button
              variant="subtle"
              size="compact-sm"
              aria-expanded={showOlder}
              aria-controls="due-older"
              onClick={() => setShowOlder(open => !open)}
              h="auto"
              mih={44}
              styles={{ label: { whiteSpace: 'normal', textAlign: 'center' } }}
            >
              {showOlder ? 'Hide earlier bills' : `Earlier bills (${groups.older.reduce((n, g) => n + g.items.length, 0)}), when you are ready`}
            </Button>
          </>
        )}
        {showOlder && (
          <div id="due-older">
            {groups.older.map((group, index) => (
              <section key={group.period} aria-label={olderGroupHeading(group.period)}>
                {index > 0 && <Divider my="xs" />}
                <Group justify="space-between" wrap="wrap" mb={4}>
                  <Title order={3} size="h6">{olderGroupHeading(group.period)}</Title>
                  <AddAllButton group={group} onConfirm={addAll} />
                </Group>
                <Text size="sm" mb={4}>Not recorded yet. Add the ones you paid, or choose Didn't happen from the menu.</Text>
                {group.items.map(renderRow)}
              </section>
            ))}
          </div>
        )}
        {!billReminders && (
          <Anchor component={Link} to="/settings" size="sm" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>
            Get a reminder before bills are due
          </Anchor>
        )}
      </Card>
    );
  }

  return (
    <>
      {card}
      <TransactionSheet
        opened={editing !== null}
        onClose={() => setEditing(null)}
        yearMonth={currentYearMonth()}
        template={template}
        templateDate={editing?.dueDate}
        recurringId={editing?.recurring.recurringId}
        onSaved={() => { if (editing) markHandled(editing); }}
        onUndone={() => {
          if (!editing) return;
          setHandled.mutate({
            recurringId: editing.recurring.recurringId,
            period: restorablePeriod(editing.recurring),
          });
        }}
      />
    </>
  );
}
