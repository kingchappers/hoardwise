import { Suspense, lazy } from 'react';
import { Loader, Group, Stack, Text, Title } from '@mantine/core';
import { DefaultLayout } from '~/components/layout/DefaultLayout';
import { isDemo } from '~/demo/flag';
import { useDocumentTitle } from '~/hooks/useDocumentTitle';
import { pageTitle } from '~/lib/pageTitle';
import type { Route } from './+types/connect';

const TITLE = 'Connect an app';

// Loaded only outside the demo, so the demo build carries none of the consent code.
const ConsentScreen = isDemo ? null : lazy(() => import('~/components/connect/ConsentScreen').then(m => ({ default: m.ConsentScreen })));

function ConnectContent() {
  useDocumentTitle(pageTitle(TITLE));

  if (!ConsentScreen) {
    return (
      <Stack maw={480} mx="auto" py="xl">
        <Title order={1} size="h3">{TITLE}</Title>
        <Text c="dimmed">Connecting an app is not available in the demo.</Text>
      </Stack>
    );
  }
  return (
    <Suspense fallback={<Group justify="center" py="xl"><Loader aria-label="Loading" /></Group>}>
      <ConsentScreen />
    </Suspense>
  );
}

export const meta: Route.MetaFunction = () => [{ title: pageTitle(TITLE) }];

export default function Connect() {
  return (
    <DefaultLayout>
      <ConnectContent />
    </DefaultLayout>
  );
}
