import { useMemo } from 'react';
import { Link } from 'react-router';
import { Button, Group, Loader, Stack, Text, Title, VisuallyHidden } from '@mantine/core';
import { LoadError } from '~/components/layout/LoadError';
import { DefaultLayout } from '~/components/layout/DefaultLayout';
import { RELEASE_NOTES } from '~/lib/glossary';
import { WelcomeBackCard } from '~/components/budget/WelcomeBackCard';
import { LaunchOffer } from '~/components/layout/LaunchOffer';
import { WhatsChanged } from '~/components/layout/WhatsChanged';
import { GuidedTour } from '~/components/layout/GuidedTour';
import { MonthHeader } from '~/components/budget/MonthHeader';
import { CategoryProgressRow } from '~/components/budget/CategoryProgressRow';
import { HomeSummary, OtherSpendingRow } from '~/components/budget/HomeSummary';
import { MoneyAhead } from '~/components/budget/MoneyAhead';
import { TargetsOptionalCard } from '~/components/budget/TargetsOptionalCard';
import { HomePots } from '~/components/pots/HomePots';
import { DueRecurringCard } from '~/components/recurring/DueRecurringCard';
import { TransactionRow } from '~/components/transactions/TransactionRow';
import { useTransactionEditing } from '~/components/transactions/useTransactionEditing';
import { groupItems, bucketKeyFor } from '~/lib/categoryGroups';
import { buildMonthSummary, monthPacePercent } from '~/lib/summary';
import type { CategoryProgress } from '~/lib/summary';
import { formatPence } from '~/lib/money';
import { currentYearMonth, formatMonthLabel, monthPhrase, shiftMonth, startOfWeekIso, todayIso } from '~/lib/months';
import { useDocumentTitle } from '~/hooks/useDocumentTitle';
import { useSelectedMonth } from '~/hooks/useSelectedMonth';
import { useCategories, usePots, useRecurring, useTargets, useTransactions, useTransactionsRange } from '~/lib/queries';
import { billsBeforePayday } from '~/lib/moneyAhead';
import { usePreferences } from '~/lib/preferences';
import { pageTitle } from '~/lib/pageTitle';
import { computeMonthFigures, type PotMonthInput } from '../../src/shared/monthFigures';
import type { Route } from './+types/_index';

function categoryTransactionsUrl(yearMonth: string, categoryId: string): string {
  return `/transactions?month=${yearMonth}&category=${encodeURIComponent(categoryId)}`;
}

function GroupedProgress({ items, yearMonth }: { items: CategoryProgress[]; yearMonth: string }) {
  const pace = monthPacePercent(yearMonth);
  const captionedId = items.find(p => !p.week)?.categoryId;
  return (
    <>
      {groupItems(items, p => bucketKeyFor({ group: p.group, type: 'EXPENSE' }), p => p.name).map(bucket => (
        <div key={bucket.key} style={{ marginTop: 'var(--mantine-spacing-lg)' }}>
          <Text size="sm" fw={600} c="dimmed" tt="uppercase" mb={2}>{bucket.label}</Text>
          {bucket.items.map(p => (
            <CategoryProgressRow
              key={p.categoryId}
              progress={p}
              pace={pace}
              paceCaption={p.categoryId === captionedId}
              to={categoryTransactionsUrl(yearMonth, p.categoryId)}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function HomeContent() {
  const [yearMonth, setYearMonth] = useSelectedMonth();
  useDocumentTitle(pageTitle('Home', formatMonthLabel(yearMonth)));
  const categories = useCategories();
  const targets = useTargets();
  const transactions = useTransactions(yearMonth);
  const potsEnabled = yearMonth <= shiftMonth(currentYearMonth(), 1);
  const pots = usePots(yearMonth, potsEnabled);
  const { rowActions, sheets } = useTransactionEditing(yearMonth);
  const lastMonth = currentYearMonth();
  const [{ payDay }] = usePreferences();
  const recurring = useRecurring();
  const history = useTransactionsRange(shiftMonth(lastMonth, -11), lastMonth);

  // A weekly target is measured against this week. When that week began in the
  // previous month, last month's transactions are needed to count it fully.
  const today = todayIso();
  const viewingCurrentMonth = yearMonth === currentYearMonth();
  const hasWeeklyTarget = (targets.data ?? []).some(t => t.period === 'WEEKLY');
  const weekNeedsPreviousMonth = viewingCurrentMonth && hasWeeklyTarget && startOfWeekIso(today).slice(0, 7) < yearMonth;
  const previousMonth = useTransactions(shiftMonth(yearMonth, -1), weekNeedsPreviousMonth);

  const isLoading = categories.isLoading || targets.isLoading || transactions.isLoading
    || (weekNeedsPreviousMonth && previousMonth.isLoading);
  const error = categories.error || targets.error || transactions.error
    || (weekNeedsPreviousMonth ? previousMonth.error : null);

  const summary = useMemo(() => buildMonthSummary({
    transactions: transactions.data ?? [],
    categories: categories.data ?? [],
    targets: targets.data ?? [],
    yearMonth,
    today: viewingCurrentMonth ? today : undefined,
    weekTransactions: weekNeedsPreviousMonth
      ? [...(transactions.data ?? []), ...(previousMonth.data ?? [])]
      : undefined,
  }), [transactions.data, categories.data, targets.data, yearMonth, viewingCurrentMonth, today, weekNeedsPreviousMonth, previousMonth.data]);

  const figures = useMemo(() => {
    const potCategoryIds = new Set(
      (categories.data ?? []).filter(c => c.type === 'POT').map(c => c.categoryId),
    );
    const potInputs: PotMonthInput[] = [];
    for (const pot of pots.data ?? []) {
      const month = pot.months.find(m => m.yearMonth === yearMonth);
      if (month) potInputs.push(month);
    }
    return computeMonthFigures({ transactions: transactions.data ?? [], potCategoryIds, pots: potInputs });
  }, [transactions.data, categories.data, pots.data, yearMonth]);

  const nameFor = (id: string) =>
    categories.data?.find(c => c.categoryId === id)?.name ?? 'Unknown category';

  const iconFor = (id: string) =>
    categories.data?.find(c => c.categoryId === id)?.icon ?? 'tag';

  if (error) {
    return (
      <LoadError thing="budget" onRetry={() => { categories.refetch(); targets.refetch(); transactions.refetch(); }} />
    );
  }

  if (isLoading) return <Group justify="center" py="xl"><Loader /></Group>;

  const hasTargets = summary.spending.length > 0;
  const moneyAhead = viewingCurrentMonth && payDay !== null && recurring.data
    ? billsBeforePayday(recurring.data, transactions.data ?? [], today, payDay)
    : null;
  const phrase = monthPhrase(yearMonth);

  return (
    <Stack gap="xl">
      <VisuallyHidden><Title order={1}>Home</Title></VisuallyHidden>
      <DueRecurringCard />
      <MonthHeader yearMonth={yearMonth} onChange={setYearMonth} />
      <HomeSummary summary={summary} figures={figures} yearMonth={yearMonth} />
      {moneyAhead && <MoneyAhead ahead={moneyAhead} />}
      <WelcomeBackCard />
      <WhatsChanged
        isNewUser={history.isSuccess && history.data.length === 0}
        notes={[
          { key: 'menu-2026-10', text: RELEASE_NOTES.menu },
          { key: 'names-2026-10', text: RELEASE_NOTES.names },
        ]}
      />

      {!hasTargets && <TargetsOptionalCard />}

      {hasTargets && (
        <div>
          <Title order={2} size="h5" mb="xs">Spending vs budget</Title>
          <GroupedProgress items={summary.spending} yearMonth={yearMonth} />
          {summary.spentUnbudgeted > 0 && <OtherSpendingRow amount={summary.spentUnbudgeted} yearMonth={yearMonth} />}
        </div>
      )}

      {potsEnabled && (pots.error ? (
        <Text size="sm" c="dimmed">We couldn't load your pots. Nothing has been lost.</Text>
      ) : (
        <HomePots pots={pots.data ?? []} categories={categories.data ?? []} />
      ))}

      <div>
        <Title order={2} size="h5" mb="xs">Recent</Title>
        {summary.recent.length === 0
          ? <Text c="dimmed" size="sm">Nothing logged {phrase}.</Text>
          : summary.recent.map(t => (
              <TransactionRow
                key={t.transactionId}
                transaction={t}
                categoryName={nameFor(t.categoryId)}
                categoryIcon={iconFor(t.categoryId)}
                {...rowActions(t)}
              />
            ))}
        <Button component={Link} to={`/transactions?month=${yearMonth}`} variant="subtle" mt="xs">See all</Button>
      </div>

      <Button component={Link} to="/plan?tab=recurring" variant="subtle" style={{ alignSelf: 'flex-start' }}>
        Manage recurring
      </Button>

      <LaunchOffer entryCount={history.data?.length ?? 0} />

      {sheets}
    </Stack>
  );
}

export const meta: Route.MetaFunction = () => [{ title: pageTitle('Home') }];

export default function Home() {
  return (
    <DefaultLayout>
      <HomeContent />
      <GuidedTour />
    </DefaultLayout>
  );
}
