import { Link, useNavigate } from 'react-router';
import { Button, Card, Input, Radio, SegmentedControl, Select, Stack, Switch, Text, Title, useMantineColorScheme } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { DefaultLayout } from '~/components/layout/DefaultLayout';
import { isDemo } from '~/demo/flag';
import { AiAssistants } from '~/components/settings/AiAssistants';
import { AccessTokens } from '~/components/settings/AccessTokens';
import { BillReminders } from '~/components/settings/BillReminders';
import { TOUR_PARAM } from '~/components/layout/GuidedTour';
import { usePreferences, type TextSize, type UndoDuration } from '~/lib/preferences';
import { TEXT_SIZE_OPTIONS } from '~/lib/textSize';
import { UNDO_DURATION_OPTIONS } from '~/lib/undoDuration';
import { SESSION_LIFETIME_TEXT } from '~/lib/sessionLifetime';
import { pageTitle } from '~/lib/pageTitle';
import { formatDayOfMonth } from '~/lib/recurring';
import type { Route } from './+types/settings';

// Places that used to sit in the More menu. One way to each of them, from here.
const MANAGE_LINKS = [
  { to: '/categories', label: 'Categories', hint: 'Add, rename or remove spending and income categories.' },
  { to: '/accounts', label: 'Accounts', hint: 'Balances of your bank accounts, savings and debts.' },
  { to: '/deleted', label: 'Recently deleted', hint: 'Bring back something you removed.' },
  { to: '/catch-up', label: 'Catch up', hint: 'Add what you remember from the last few weeks.' },
];

const PAY_DAY_OPTIONS = Array.from({ length: 28 }, (_, index) => ({ value: String(index + 1), label: formatDayOfMonth(index + 1) }));

const APPEARANCE_OPTIONS = [
  { value: 'auto', label: 'Match my device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function SettingsContent() {
  const [preferences, setPreferences] = usePreferences();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const navigate = useNavigate();

  function replayTour(): void {
    setPreferences({ tourStep: 0 });
    navigate(`/?${TOUR_PARAM}=1`);
  }

  return (
    <Stack maw={640}>
      <Title order={1} size="h3">Settings</Title>
      <Text size="sm" c="dimmed">Most settings are saved on this device.</Text>

      <Card withBorder>
        <Title order={2} size="h4" mb="sm">Signing in</Title>
        <Text size="sm">{SESSION_LIFETIME_TEXT}</Text>
      </Card>

      {!isDemo && <AiAssistants />}
      {!isDemo && <AccessTokens />}

      <Card withBorder>
        <Title order={2} size="h4" mb="sm">Display</Title>
        <Stack gap="md">
          <Input.Wrapper label="Text size" description="Makes text bigger everywhere. It changes straight away.">
            <SegmentedControl
              fullWidth
              mt={4}
              aria-label="Text size"
              value={preferences.textSize}
              onChange={value => setPreferences({ textSize: value as TextSize })}
              data={TEXT_SIZE_OPTIONS}
            />
          </Input.Wrapper>
          <Input.Wrapper label="Appearance" description="Light, dark, or whichever your device is set to.">
            <SegmentedControl
              fullWidth
              mt={4}
              aria-label="Appearance"
              value={colorScheme}
              onChange={value => setColorScheme(value as 'auto' | 'light' | 'dark')}
              data={APPEARANCE_OPTIONS}
            />
          </Input.Wrapper>
          <Switch
            label="Reduce motion"
            description="Stops sliding and fading when sheets, menus and messages open. The app already follows your device's setting; this switch turns it on for the app only."
            checked={preferences.reduceMotion}
            onChange={event => setPreferences({ reduceMotion: event.currentTarget.checked })}
          />
          <Switch
            label="Show milestones"
            description="A short text note on Insights when a pot reaches its goal or a month finishes under budget. No streaks, sounds or animations."
            checked={preferences.showMilestones}
            onChange={event => setPreferences({ showMilestones: event.currentTarget.checked })}
          />
        </Stack>
      </Card>

      <Card withBorder>
        <Title order={2} size="h4" mb="sm">Messages</Title>
        <Radio.Group
          label="How long messages with an Undo button stay"
          description="Saved, deleted and skipped messages. Errors always stay until you close them."
          value={preferences.undoDuration}
          onChange={value => setPreferences({ undoDuration: value as UndoDuration })}
        >
          <Stack gap="xs" mt="xs">
            {UNDO_DURATION_OPTIONS.map(option => (
              <Radio key={option.value} value={option.value} label={option.label} />
            ))}
          </Stack>
        </Radio.Group>
        <Switch
          mt="md"
          label="Show what is left after saving"
          description={'Adds a line to the Saved message, such as "£395.50 left in Groceries this month." Only for spending in a category with a monthly budget. Off unless you turn it on.'}
          checked={preferences.leftAfterSave}
          onChange={event => setPreferences({ leftAfterSave: event.currentTarget.checked })}
        />
      </Card>

      <Card withBorder>
        <Title order={2} size="h4" mb="sm">Money</Title>
        <Select
          label="Pay day"
          description="The day of the month your pay arrives. Home then shows the bills due before your next one. Nothing else changes."
          placeholder="Not set"
          clearable
          data={PAY_DAY_OPTIONS}
          value={preferences.payDay === null ? null : String(preferences.payDay)}
          onChange={value => setPreferences({ payDay: value === null ? null : Number(value) })}
        />
      </Card>

      <Card withBorder>
        <Title order={2} size="h4" mb="sm">Keyboard and launch</Title>
        <Switch
          label="Press N to add a transaction"
          description="Turn this off if it opens the Add sheet when you don't mean it to, for example while using dictation."
          checked={preferences.shortcutN}
          onChange={event => setPreferences({ shortcutN: event.currentTarget.checked })}
        />
        <Switch
          mt="md"
          label="Open Add sheet when the installed app starts"
          description="Only applies when the app is installed on this device."
          checked={preferences.openAddOnLaunch}
          onChange={event => setPreferences({ openAddOnLaunch: event.currentTarget.checked })}
        />
      </Card>

      {!isDemo && <BillReminders />}

      <Card withBorder>
        <Title order={2} size="h4" mb="sm">Manage</Title>
        <Stack gap={0}>
          {MANAGE_LINKS.map(({ to, label, hint }) => (
            <Link
              key={to}
              to={to}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                minHeight: 44, padding: '8px 0', textDecoration: 'none', color: 'inherit',
              }}
            >
              <span>
                <Text fw={500}>{label}</Text>
                <Text size="sm" c="dimmed">{hint}</Text>
              </span>
              <IconChevronRight size={18} aria-hidden />
            </Link>
          ))}
        </Stack>
        <Text fw={500} mt="md">Guided tour</Text>
        <Text size="sm" mb="xs">Three short screens on budgets, pots and recurring bills.</Text>
        <Button variant="default" onClick={replayTour}>Take the tour again</Button>
      </Card>

      <Card withBorder>
        <Title order={2} size="h4" mb="sm">Help</Title>
        <Link
          to="/about"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            minHeight: 44, padding: '8px 0', textDecoration: 'none', color: 'inherit',
          }}
        >
          <span>
            <Text fw={500}>Help and about</Text>
            <Text size="sm" c="dimmed">A short tour of every page, with pictures.</Text>
          </span>
          <IconChevronRight size={18} aria-hidden />
        </Link>
        {!isDemo && (
          <Link
            to="/docs"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              minHeight: 44, padding: '8px 0', textDecoration: 'none', color: 'inherit',
            }}
          >
            <span>
              <Text fw={500}>API docs</Text>
              <Text size="sm" c="dimmed">How to read your data with an access token.</Text>
            </span>
            <IconChevronRight size={18} aria-hidden />
          </Link>
        )}
      </Card>
    </Stack>
  );
}

export const meta: Route.MetaFunction = () => [{ title: pageTitle('Settings') }];

export default function Settings() {
  return (
    <DefaultLayout>
      <SettingsContent />
    </DefaultLayout>
  );
}
