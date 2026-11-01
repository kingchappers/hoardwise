import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Card, Group, Loader, PasswordInput, Radio, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { useAuth } from '~/lib/auth';
import { ApiError } from '~/lib/apiError';
import { clearConnectReturn } from '~/lib/connectReturn';
import { navigateExternal } from '~/lib/navigateExternal';
import type { ConnectScope } from '~/lib/oauthApi';
import { useAuthorizeClient, useOauthClient } from '~/lib/oauthQueries';
import { isRedirectToAllowed, parseConnectParams } from './connectParams';

const INVALID_REQUEST = "This connection request isn't valid. Go back to Claude and try again.";
const WRONG_PASSWORD = "That password isn't right. Try again.";
const TOO_MANY = 'Too many attempts. Wait a few minutes, then try again.';
const FAILED = "Couldn't connect. Nothing was shared. Try again.";

type Failure = { kind: 'invalid' } | { kind: 'message'; text: string };

function failureFor(error: unknown, sentPassword: boolean): Failure {
  if (!(error instanceof ApiError)) return { kind: 'message', text: FAILED };
  if (error.status === 404) return { kind: 'invalid' };
  // A 403 also covers a failed Origin check, so it only means a wrong password when one was sent.
  if (error.status === 403 && sentPassword) return { kind: 'message', text: WRONG_PASSWORD };
  if (error.status === 429) return { kind: 'message', text: TOO_MANY };
  return { kind: 'message', text: FAILED };
}

function InvalidRequest(): React.JSX.Element {
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <Stack maw={480} mx="auto" gap="md" py="xl">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <IconAlertTriangle size={24} aria-hidden="true" style={{ flexShrink: 0 }} />
        <Title order={1} size="h3" ref={heading} tabIndex={-1} style={{ outline: 'none' }}>This request can't be used</Title>
      </Group>
      <Text>{INVALID_REQUEST}</Text>
      <Button variant="default" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/')}>Go to Hoardwise</Button>
    </Stack>
  );
}

export function ConsentScreen(): React.JSX.Element {
  const [search] = useSearchParams();
  const params = parseConnectParams(search);
  const { mode } = useAuth();
  const navigate = useNavigate();
  const client = useOauthClient(params?.clientId, params?.redirectUri);
  const authorize = useAuthorizeClient();
  const [scope, setScope] = useState<ConnectScope>('read');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const ready = client.data !== undefined;

  // Signed in now, so the remembered request (kept in case sign-in left this page) has done its job.
  useEffect(() => { clearConnectReturn(); }, []);
  useEffect(() => { if (ready) heading.current?.focus(); }, [ready]);

  const asksForPassword = mode === 'local' && scope === 'write';

  function chooseScope(value: string): void {
    setScope(value === 'write' ? 'write' : 'read');
    setPassword('');
    setPasswordError(null);
  }

  function cancel(): void {
    clearConnectReturn();
    navigate('/');
  }

  async function connect(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!params || pending.current) return;
    setFailure(null);
    if (asksForPassword && password === '') {
      setPasswordError('Enter your password to continue.');
      passwordField.current?.focus();
      return;
    }
    setPasswordError(null);

    pending.current = true;
    setBusy(true);
    const sentPassword = asksForPassword;
    try {
      const result = await authorize.mutateAsync({
        clientId: params.clientId,
        redirectUri: params.redirectUri,
        scope,
        codeChallenge: params.codeChallenge,
        ...(params.state !== undefined ? { state: params.state } : {}),
        ...(sentPassword ? { password } : {}),
      });
      if (!isRedirectToAllowed(result.redirectTo, params.redirectUri)) {
        console.error('Connection refused: the redirect did not match the request', { clientId: params.clientId });
        setFailure({ kind: 'message', text: FAILED });
        return;
      }
      setPassword('');
      setConnected(true);
      navigateExternal(result.redirectTo);
    } catch (error) {
      console.error('Connecting failed', { clientId: params.clientId, scope, error });
      setFailure(failureFor(error, sentPassword));
      setPassword('');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (!params || client.error instanceof ApiError && client.error.status === 404 || failure?.kind === 'invalid') {
    return <InvalidRequest />;
  }
  if (client.error) {
    return (
      <Stack maw={480} mx="auto" gap="md" py="xl">
        <Title order={1} size="h3">Couldn't check this request</Title>
        <Text>Something went wrong on our side. Nothing was shared.</Text>
        <Group>
          <Button onClick={() => void client.refetch()}>Try again</Button>
          <Button variant="default" onClick={cancel}>Cancel</Button>
        </Group>
      </Stack>
    );
  }
  if (!client.data) {
    return (
      <Group justify="center" py="xl" role="status" aria-label="Checking this connection request">
        <Loader />
      </Group>
    );
  }

  const { redirectHost } = client.data;
  const name = client.data.name.trim() === '' ? 'An app' : client.data.name;

  if (connected) {
    return (
      <Stack maw={480} mx="auto" gap="md" py="xl">
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <IconCircleCheck size={24} aria-hidden="true" style={{ flexShrink: 0 }} />
          <Title order={1} size="h3" ref={heading} tabIndex={-1} style={{ outline: 'none' }}>Connected</Title>
        </Group>
        <Text role="status">Connected. You can go back to Claude.</Text>
      </Stack>
    );
  }

  return (
    <Card withBorder maw={480} mx="auto" my="xl" padding="lg">
      <form noValidate onSubmit={event => void connect(event)}>
        <Stack gap="md">
          <Title order={1} size="h3" ref={heading} tabIndex={-1} style={{ outline: 'none' }}>
            <strong>{name}</strong> wants to connect to your Hoardwise
          </Title>
          <Text size="sm">It will send you back to {redirectHost}</Text>
          <Radio.Group label="What can it do?" value={scope} onChange={chooseScope}>
            <Stack gap="sm" mt="xs">
              <Radio value="read" label="View only" description="It can look at your budget and keep your chart styles" />
              <Radio value="write" label="View and change" description="It can also add spends and incomes when you say yes" />
            </Stack>
          </Radio.Group>
          {asksForPassword && (
            <PasswordInput
              ref={passwordField}
              label="Your password"
              description="Needed to let it change your data."
              autoComplete="current-password"
              value={password}
              error={passwordError}
              onChange={event => setPassword(event.currentTarget.value)}
            />
          )}
          {failure?.kind === 'message' && (
            <Alert variant="light" icon={<IconAlertTriangle size={18} aria-hidden="true" />} role="alert">{failure.text}</Alert>
          )}
          <Group>
            <Button type="submit" loading={busy}>Connect</Button>
            <Button variant="default" onClick={cancel} disabled={busy}>Cancel</Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}
