import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router';

vi.mock('~/components/layout/DefaultLayout', () => ({
  DefaultLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const demo = vi.hoisted(() => ({ isDemo: false }));
vi.mock('~/demo/flag', () => ({ get isDemo() { return demo.isDemo; } }));

vi.mock('~/lib/queries', () => ({
  useApi: () => ({}),
  useAccessTokens: () => ({ data: [], isLoading: false, error: null, refetch: vi.fn() }),
  useCreateAccessToken: () => ({ mutateAsync: vi.fn(), reset: vi.fn(), isPending: false }),
  useRevokeAccessToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('~/lib/auth', () => ({ useAuth: () => ({ mode: 'auth0' }) }));

import Settings from '../settings';
import { SESSION_LIFETIME_TEXT } from '~/lib/sessionLifetime';
import { TextSize } from '~/components/layout/TextSize';
import { DEFAULT_PREFERENCES, readPreferences, writePreferences } from '~/lib/preferences';
import { expectNoViolations, expectSoundHeadings } from '~/test-utils/accessibility';

function renderSettings() {
  return render(
    <MantineProvider env="test">
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </MantineProvider>,
  );
}

beforeEach(() => {
  demo.isDemo = false;
  window.localStorage.clear();
});

describe('Settings page', () => {
  it('links to the help and about page', () => {
    renderSettings();
    expect(screen.getByRole('link', { name: /^Help and about/ })).toHaveAttribute('href', '/about');
  });

  it('links to the API docs', () => {
    renderSettings();
    expect(screen.getByRole('link', { name: /^API docs/ })).toHaveAttribute('href', '/docs');
  });

  it('hides the API docs link in the demo', () => {
    demo.isDemo = true;
    renderSettings();
    expect(screen.queryByRole('link', { name: /^API docs/ })).not.toBeInTheDocument();
  });

  it('shows the AI assistants section, and hides it in the demo', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'AI assistants' })).toBeInTheDocument();
    demo.isDemo = true;
    renderSettings();
    expect(screen.getAllByRole('heading', { name: 'AI assistants' })).toHaveLength(1);
  });

  it('has a Settings heading', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('does not claim that everything is saved on this device, since access tokens are kept on the server', () => {
    renderSettings();
    expect(screen.getByText('Most settings are saved on this device.')).toBeInTheDocument();
  });

  it('shows the Reduce motion switch off by default and saves it when turned on', async () => {
    renderSettings();
    const toggle = screen.getByRole('switch', { name: /^Reduce motion/ });
    expect(toggle).not.toBeChecked();

    await userEvent.setup().click(toggle);

    expect(screen.getByRole('switch', { name: /^Reduce motion/ })).toBeChecked();
    expect(readPreferences(window.localStorage).reduceMotion).toBe(true);
  });

  it('shows the N shortcut switch on by default and saves it when turned off', async () => {
    renderSettings();
    const toggle = screen.getByRole('switch', { name: /^Press N to add a transaction/ });
    expect(toggle).toBeChecked();

    await userEvent.setup().click(toggle);

    expect(screen.getByRole('switch', { name: /^Press N to add a transaction/ })).not.toBeChecked();
    expect(readPreferences(window.localStorage).shortcutN).toBe(false);
  });

  it('shows the launch switch off by default and saves it when turned on', async () => {
    renderSettings();
    const toggle = screen.getByRole('switch', { name: /^Open Add sheet when the installed app starts/ });
    expect(toggle).not.toBeChecked();

    await userEvent.setup().click(toggle);

    expect(screen.getByRole('switch', { name: /^Open Add sheet when the installed app starts/ })).toBeChecked();
    expect(readPreferences(window.localStorage).openAddOnLaunch).toBe(true);
  });

  it('reflects preferences saved earlier', () => {
    writePreferences(window.localStorage, { ...DEFAULT_PREFERENCES, shortcutN: false, openAddOnLaunch: true });
    renderSettings();
    expect(screen.getByRole('switch', { name: /^Press N to add a transaction/ })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /^Open Add sheet when the installed app starts/ })).toBeChecked();
  });

  it('keeps milestones off until they are switched on', async () => {
    renderSettings();
    const toggle = screen.getByRole('switch', { name: /^Show milestones/ });
    expect(toggle).not.toBeChecked();

    await userEvent.setup().click(toggle);

    expect(toggle).toBeChecked();
    expect(readPreferences(window.localStorage).showMilestones).toBe(true);
  });

  it('keeps the after-save line off until it is switched on', async () => {
    renderSettings();
    const toggle = screen.getByRole('switch', { name: /^Show what is left after saving/ });
    expect(toggle).not.toBeChecked();

    await userEvent.setup().click(toggle);

    expect(toggle).toBeChecked();
    expect(readPreferences(window.localStorage).leftAfterSave).toBe(true);
  });

  it('starts with no pay day, and saves one when chosen', async () => {
    renderSettings();
    const field = screen.getByRole('textbox', { name: 'Pay day' });
    expect(field).toHaveValue('');

    await userEvent.setup().click(field);
    await userEvent.setup().click(await screen.findByRole('option', { name: '25th' }));

    expect(readPreferences(window.localStorage).payDay).toBe(25);
  });

  it('says what milestones are and what they are not', () => {
    renderSettings();
    expect(screen.getByText(/no streaks, sounds or animations/i)).toBeInTheDocument();
  });

  it('holds the pages that used to be in the More menu, one link each', () => {
    renderSettings();
    const manage = screen.getByRole('heading', { name: 'Manage' }).closest('.mantine-Card-root') as HTMLElement;
    const links = [...manage.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href')]);
    expect(links).toEqual([
      ['CategoriesAdd, rename or remove spending and income categories.', '/categories'],
      ['AccountsBalances of your bank accounts, savings and debts.', '/accounts'],
      ['Recently deletedBring back something you removed.', '/deleted'],
      ['Catch upAdd what you remember from the last few weeks.', '/catch-up'],
    ]);
  });

  it('gives each link a 44px target', () => {
    renderSettings();
    screen.getByRole('link', { name: /^Categories/ });
    expect(screen.getByRole('link', { name: /^Categories/ })).toHaveStyle({ minHeight: '44px' });
  });

  describe('grouping', () => {
    it('groups the controls under Signing in, AI assistants, Access tokens, Display, Messages, Money, Keyboard and launch, Reminders, Manage and Help, in that order', () => {
      renderSettings();
      const headings = screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent);
      expect(headings).toEqual(['Signing in', 'AI assistants', 'Access tokens', 'Display', 'Messages', 'Money', 'Keyboard and launch', 'Reminders', 'Manage', 'Help']);
    });

    it('keeps to a handful of controls, each with a line of plain help', () => {
      renderSettings();
      const controls = [
        ...screen.getAllByRole('radiogroup'),
        ...screen.getAllByRole('switch'),
      ];
      expect(controls.length).toBeLessThanOrEqual(10);
      expect(screen.getByText('Makes text bigger everywhere. It changes straight away.')).toBeInTheDocument();
      expect(screen.getByText('Light, dark, or whichever your device is set to.')).toBeInTheDocument();
      expect(screen.getByText(/Saved, deleted and skipped messages/)).toBeInTheDocument();
    });
  });

  describe('text size', () => {
    it('starts at Standard', () => {
      renderSettings();
      expect(screen.getByRole('radio', { name: 'Standard' })).toBeChecked();
    });

    it.each([['Large', 'large'], ['Largest', 'largest']])('saves %s', async (label, value) => {
      renderSettings();
      await userEvent.setup().click(screen.getByRole('radio', { name: label }));
      expect(screen.getByRole('radio', { name: label })).toBeChecked();
      expect(readPreferences(window.localStorage).textSize).toBe(value);
    });

    it('comes back from the saved choice', () => {
      writePreferences(window.localStorage, { ...DEFAULT_PREFERENCES, textSize: 'largest' });
      renderSettings();
      expect(screen.getByRole('radio', { name: 'Largest' })).toBeChecked();
    });

    it('takes effect on the page straight away when the app applies it', async () => {
      document.documentElement.removeAttribute('data-text-size');
      render(
        <MantineProvider env="test">
          <MemoryRouter>
            <TextSize />
            <Settings />
          </MemoryRouter>
        </MantineProvider>,
      );
      await userEvent.setup().click(screen.getByRole('radio', { name: 'Large' }));
      expect(document.documentElement.getAttribute('data-text-size')).toBe('large');
    });
  });

  describe('appearance', () => {
    it('offers Match my device, Light and Dark, starting on the device setting', () => {
      // The app starts on "auto"; the plain test provider would start on light.
      render(
        <MantineProvider env="test" defaultColorScheme="auto">
          <MemoryRouter>
            <Settings />
          </MemoryRouter>
        </MantineProvider>,
      );
      expect(screen.getAllByRole('radio', { name: /^(Match my device|Light|Dark)$/ }).map(radio => radio.getAttribute('value')))
        .toEqual(['auto', 'light', 'dark']);
      expect(screen.getByRole('radio', { name: 'Match my device' })).toBeChecked();
    });

    it('switches the page to dark and remembers it', async () => {
      renderSettings();
      await userEvent.setup().click(screen.getByRole('radio', { name: 'Dark' }));
      expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
      expect(window.localStorage.getItem('mantine-color-scheme-value')).toBe('dark');
    });
  });

  describe('undo messages', () => {
    it('defaults to until I close them', () => {
      renderSettings();
      expect(screen.getByRole('radio', { name: 'Until I close them' })).toBeChecked();
    });

    it.each([['30 seconds', '30s'], ['10 seconds', '10s'], ['Until I close them', 'until-closed']])('saves %s', async (label, value) => {
      writePreferences(window.localStorage, { ...DEFAULT_PREFERENCES, undoDuration: value === 'until-closed' ? '10s' : 'until-closed' });
      renderSettings();
      await userEvent.setup().click(screen.getByRole('radio', { name: label }));
      expect(readPreferences(window.localStorage).undoDuration).toBe(value);
    });

    it('says that errors always stay', () => {
      renderSettings();
      expect(screen.getByText(/Errors always stay until you close them/)).toBeInTheDocument();
    });
  });

  it('restarts the guided tour from the beginning', async () => {
    writePreferences(window.localStorage, { ...DEFAULT_PREFERENCES, tourStep: 3 });
    renderSettings();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Take the tour again' }));

    expect(readPreferences(window.localStorage).tourStep).toBe(0);
  });
});

describe('Accessibility', () => {
  it('has one h1 and no skipped heading levels', () => {
    renderSettings();
    expectSoundHeadings(document.body);
  });

  it('has no unlabelled controls, empty buttons or empty headings', async () => {
    renderSettings();
    await expectNoViolations(document.body);
  });

  it('says how long you stay signed in, from the shared wording', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Signing in' })).toBeInTheDocument();
    expect(screen.getByText(SESSION_LIFETIME_TEXT)).toBeInTheDocument();
  });

  it('has an Access tokens section', () => {
    renderSettings();
    expect(screen.getByRole('heading', { level: 2, name: 'Access tokens' })).toBeInTheDocument();
  });

  it('hides the Access tokens section in the demo, which has no token routes', () => {
    demo.isDemo = true;
    renderSettings();
    expect(screen.queryByRole('heading', { name: 'Access tokens' })).not.toBeInTheDocument();
  });

  it('has a Reminders section with bill reminders off', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Reminders' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /^Remind me about bills/ })).not.toBeChecked();
  });
});
