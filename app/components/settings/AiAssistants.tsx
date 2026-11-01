import { useEffect, useState } from 'react';
import { Button, Card, Code, Collapse, Group, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy } from '@tabler/icons-react';

const COPIED_FOR_MS = 1000;
const COPY_FAILED = "Couldn't copy automatically. The address is selected: copy it with your keyboard.";

type CopyState = 'idle' | 'copied' | 'failed';

function CommandBlock({ children }: { children: string }): React.JSX.Element {
  return (
    <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{children}</Code>
  );
}

function McpAddress({ url }: { url: string }): React.JSX.Element {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = window.setTimeout(() => setCopyState('idle'), COPIED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  // navigator.clipboard only exists in secure contexts, and self-hosting over plain HTTP is supported.
  async function copy(): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error('The clipboard is not available here');
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch (error) {
      console.error('Copying the Hoardwise address failed', { error });
      setCopyState('failed');
    }
  }

  const copied = copyState === 'copied';

  return (
    <Stack gap="xs">
      <TextInput
        label="Your Hoardwise address"
        value={url}
        readOnly
        autoComplete="off"
        spellCheck={false}
        onFocus={event => event.currentTarget.select()}
        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
      />
      <Group gap="sm">
        <Button
          variant="default"
          leftSection={copied ? <IconCheck size={18} aria-hidden="true" /> : <IconCopy size={18} aria-hidden="true" />}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </Group>
      <Text size="sm" role="status">{copyState === 'failed' ? COPY_FAILED : ''}</Text>
    </Stack>
  );
}

function Client({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Stack gap={6}>
      <Title order={3} size="h5">{title}</Title>
      {children}
    </Stack>
  );
}

function DeveloperExample({ url }: { url: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const Chevron = open ? IconChevronDown : IconChevronRight;
  const curl = `curl -sS ${url} \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

  return (
    <div>
      <UnstyledButton
        aria-expanded={open}
        aria-controls="ai-developer-example"
        onClick={() => setOpen(value => !value)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44 }}
      >
        <Chevron size={18} aria-hidden="true" />
        <Text fw={500}>For developers and self-hosters</Text>
      </UnstyledButton>
      <Collapse in={open} id="ai-developer-example">
        <Stack gap="xs">
          <Text size="sm">Set TOKEN to an access token from the list below, then ask the server which tools it has.</Text>
          <CommandBlock>{curl}</CommandBlock>
          <Text size="sm">A request with a missing Accept or Content-Type header is refused.</Text>
        </Stack>
      </Collapse>
    </div>
  );
}

// The page cannot tell whether sign-in connections are turned on: config.json only says how this page signs in.
export function AiAssistants(): React.JSX.Element {
  const url = `${window.location.origin}/mcp`;

  return (
    <Card withBorder>
      <Title order={2} size="h4" mb="sm">AI assistants</Title>
      <Stack gap="md">
        <Text size="sm">
          Connect an AI assistant such as Claude to ask about your budget in plain words. It uses the address below. Read-only access lets it look at your data; it can only add spending or income if you give it a token that can write.
        </Text>
        <McpAddress url={url} />

        <Client title="Claude on the web or desktop">
          <ol style={{ listStyleType: 'decimal', paddingInlineStart: 24, margin: 0, display: 'grid', gap: 4, fontSize: 'var(--mantine-font-size-sm)' }}>
            <li>In Claude, go to Settings → Connectors → Add custom connector.</li>
            <li>Paste the address above.</li>
            <li>Choose Connect and sign in to Hoardwise.</li>
          </ol>
          <Text size="sm">The Claude phone app shows connectors you add on the web or desktop. A phone cannot add a new one.</Text>
          <Text size="sm">If Connect does not work, ask whoever runs this Hoardwise to turn on sign-in connections (self-hosters: set APP_ORIGIN).</Text>
        </Client>

        <Client title="Claude Code">
          <Text size="sm">Run this in your terminal. Make a token in the access tokens section below and put it in place of the placeholder.</Text>
          <CommandBlock>{`claude mcp add --transport http hoardwise ${url} --header "Authorization: Bearer <your token>"`}</CommandBlock>
        </Client>

        <Client title="Cursor, ChatGPT and other apps that support remote MCP">
          <Text size="sm">Paste the address above where the app asks for a remote MCP server. It may ask you to sign in.</Text>
        </Client>

        <DeveloperExample url={url} />
      </Stack>
    </Card>
  );
}
