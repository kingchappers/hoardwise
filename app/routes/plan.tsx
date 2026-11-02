import { useSearchParams } from 'react-router';
import { Stack, Tabs, Title } from '@mantine/core';
import { PlanDraftProvider } from '~/components/plan/PlanDraftContext';
import { PlanSummary } from '~/components/plan/PlanSummary';
import { DefaultLayout } from '~/components/layout/DefaultLayout';
import { useDocumentTitle } from '~/hooks/useDocumentTitle';
import { isPlanTab, normalisePlanTab, PLAN_TABS, type PlanTab } from '~/lib/planTabs';
import { pageTitle } from '~/lib/pageTitle';
import { PotsContent } from './pots';
import { RecurringContent } from './recurring';
import { BudgetsContent } from './budgets';
import type { Route } from './+types/plan';

function PlanContent() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: PlanTab = normalisePlanTab(requested) ?? 'budgets';
  const label = PLAN_TABS.find(item => item.value === tab)?.label ?? 'Budgets';
  useDocumentTitle(pageTitle('Plan', label));

  return (
    <Stack>
      <Title order={1} size="h3">Plan</Title>
      <PlanSummary />
      <Tabs
        value={tab}
        // Moving between tabs drops anything meant for the tab you left.
        onChange={value => { if (isPlanTab(value)) setParams({ tab: value }, { replace: true }); }}
        keepMounted={false}
      >
        <Tabs.List>
          {PLAN_TABS.map(item => (
            <Tabs.Tab key={item.value} value={item.value} style={{ minHeight: 44 }}>{item.label}</Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="budgets" pt="md"><BudgetsContent /></Tabs.Panel>
        <Tabs.Panel value="pots" pt="md"><PotsContent /></Tabs.Panel>
        <Tabs.Panel value="recurring" pt="md"><RecurringContent /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

export const meta: Route.MetaFunction = () => [{ title: pageTitle('Plan') }];

export default function Plan() {
  return (
    <DefaultLayout>
      <PlanDraftProvider>
        <PlanContent />
      </PlanDraftProvider>
    </DefaultLayout>
  );
}
