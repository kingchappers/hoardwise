import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, useLocation } from 'react-router';
import { PENDING_ADD_KEY } from '~/lib/launchIntent';
import { DEFAULT_PREFERENCES, writePreferences } from '~/lib/preferences';
import { clearSessionEnded, markSessionEnded } from '~/lib/session';
import { SESSION_LIFETIME_TEXT } from '~/lib/sessionLifetime';
import { rememberConnectReturn, takeConnectReturn } from '~/lib/connectReturn';

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  isLoading: false,
  error: undefined as (Error & { error?: string }) | undefined,
  loginWithRedirect: vi.fn(),
}));
vi.mock('@auth0/auth0-react', () => ({
  Auth0Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth0: () => auth,
}));
vi.mock('../../authentication/Authentication', () => ({ default: () => null }));
vi.mock('../../transactions/TransactionSheet', () => ({
  TransactionSheet: ({ opened }: { opened: boolean }) => (opened ? <div>Add sheet open</div> : null),
}));
vi.mock('../OfflineQueueBanner', () => ({ OfflineQueueBanner: () => null }));
vi.mock('../../authentication/AuthProvider', () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import { DefaultLayout } from '../DefaultLayout';

function renderLayout(children: React.ReactNode = <p>page</p>, url: string = '/') {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[url]}>
        <DefaultLayout>{children}</DefaultLayout>
      </MemoryRouter>
    </MantineProvider>,
  );
}

function authError(code: string): Error & { error: string } {
  return Object.assign(new Error(`${code}: raw provider detail`), { error: code });
}

beforeEach(() => {
  clearSessionEnded();
  auth.isAuthenticated = true;
  auth.isLoading = false;
  auth.error = undefined;
  auth.loginWithRedirect.mockClear();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('DefaultLayout add shortcut', () => {
  it('opens the add sheet when N is pressed', async () => {
    renderLayout();
    await userEvent.setup().keyboard('n');
    expect(screen.getByText('Add sheet open')).toBeInTheDocument();
  });

  it('ignores N while typing in a field', async () => {
    const user = userEvent.setup();
    renderLayout(<input aria-label="Search" />);
    await user.click(screen.getByLabelText('Search'));
    await user.keyboard('n');
    expect(screen.queryByText('Add sheet open')).not.toBeInTheDocument();
  });

  it('ignores N while another dialog is open', async () => {
    renderLayout(<div role="dialog" aria-label="Edit transaction" />);
    await userEvent.setup().keyboard('n');
    expect(screen.queryByText('Add sheet open')).not.toBeInTheDocument();
  });

  it('opens the add sheet from the tab bar', async () => {
    renderLayout();
    const tabBar = screen.getByRole('navigation', { name: 'Primary' });
    await userEvent.setup().click(within(tabBar).getByRole('button', { name: 'Add transaction' }));
    expect(screen.getByText('Add sheet open')).toBeInTheDocument();
  });

  it('opens the add sheet from the header button on wide screens', async () => {
    renderLayout();
    const header = screen.getByRole('banner');
    await userEvent.setup().click(within(header).getByRole('button', { name: 'Add transaction' }));
    expect(screen.getByText('Add sheet open')).toBeInTheDocument();
  });

  it('has no floating button: the tab bar is the only fixed layer', () => {
    const { container } = renderLayout();
    const fixed = [...container.querySelectorAll<HTMLElement>('[style]')].filter(element => element.style.position === 'fixed');
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toBe(screen.getByRole('navigation', { name: 'Primary' }));
  });

  it('clears the tab bar with page padding and keeps the tab bar height in one place', () => {
    const { container } = renderLayout();
    const main = container.querySelector('main') as HTMLElement;
    expect(main.style.paddingBottom).toContain('var(--tab-bar-height)');
    expect(screen.getByRole('navigation', { name: 'Primary' }).style.height).toBe('var(--tab-bar-height)');
  });

  it('starts with a skip link to the main content', () => {
    renderLayout();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveAttribute('href', '#main');
    expect(document.getElementById('main')).not.toBeNull();
    expect(skip.compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the quick entry tips button in the header', async () => {
    renderLayout();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Quick entry tips' }));
    expect(await screen.findByRole('dialog', { name: 'Quick entry tips' })).toBeInTheDocument();
  });

  it('ignores N while the tips dialog is open', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Quick entry tips' }));
    await screen.findByRole('dialog', { name: 'Quick entry tips' });

    await user.keyboard('n');

    expect(screen.queryByText('Add sheet open')).not.toBeInTheDocument();
  });

  it('has the same four destinations and Add in the tab bar, and no More menu', () => {
    renderLayout();
    const tabBar = screen.getByRole('navigation', { name: 'Primary' });
    const names = within(tabBar).getAllByRole('link').map(link => link.getAttribute('aria-label'));
    expect(names).toEqual(['Home', 'Transactions', 'Plan', 'Insights']);
    expect(within(tabBar).getByRole('button', { name: 'Add transaction' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('puts Add in the middle of the tab bar', () => {
    renderLayout();
    const tabBar = screen.getByRole('navigation', { name: 'Primary' });
    const order = within(tabBar).getAllByRole('link').map(link => link.getAttribute('aria-label'));
    const items = [...tabBar.querySelectorAll('a, button')].map(element => element.getAttribute('aria-label'));
    expect(items).toEqual(['Home', 'Transactions', 'Add transaction', 'Plan', 'Insights']);
    expect(order).toHaveLength(4);
  });

  it('shows the same destinations in the sidebar, once each, and Settings in the header', () => {
    renderLayout();
    for (const name of ['Home', 'Transactions', 'Plan', 'Insights']) {
      expect(screen.getAllByRole('link', { name })).toHaveLength(2);
    }
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('gives each place one route in: nothing that moved is still in the menus', () => {
    renderLayout();
    for (const name of ['Budgets', 'Pots', 'Recurring', 'Categories', 'Accounts', 'Recently deleted', 'Catch up']) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
  });

  it('links Plan to /plan from both the tab bar and the sidebar', () => {
    renderLayout();
    const links = screen.getAllByRole('link', { name: 'Plan' });
    links.forEach(link => expect(link).toHaveAttribute('href', '/plan'));
  });

  it('shows the current page by more than colour: aria-current, a bar and a bold label', () => {
    renderLayout(<p>page</p>, '/plan');
    const tabBar = screen.getByRole('navigation', { name: 'Primary' });
    const plan = within(tabBar).getByRole('link', { name: 'Plan' });
    const home = within(tabBar).getByRole('link', { name: 'Home' });

    expect(plan).toHaveAttribute('aria-current', 'page');
    expect(home).not.toHaveAttribute('aria-current');
    expect((plan.querySelector('span[aria-hidden]') as HTMLElement).style.background).toBe('currentcolor');
    expect((home.querySelector('span[aria-hidden]') as HTMLElement).style.background).toBe('transparent');
  });

  it('marks Settings as current on the pages kept under Manage', () => {
    renderLayout(<p>page</p>, '/categories');
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark Settings as current elsewhere', () => {
    renderLayout(<p>page</p>, '/plan');
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
  });

  it('keeps the Add tab away from signed-out people', () => {
    auth.isAuthenticated = false;
    renderLayout();
    expect(screen.queryByRole('button', { name: 'Add transaction' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole('link')).toHaveLength(4);
  });
});

describe('DefaultLayout launch intent', () => {
  it('opens the add sheet from ?add=1 once signed in and cleans the URL', () => {
    window.history.replaceState(null, '', '/?add=1');

    renderLayout();

    expect(screen.getByText('Add sheet open')).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('does not open the add sheet from ?add=1 while signed out', () => {
    auth.isAuthenticated = false;
    window.history.replaceState(null, '', '/?add=1');

    renderLayout();

    expect(screen.queryByText('Add sheet open')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(PENDING_ADD_KEY)).toBe('1');
  });
});

describe('DefaultLayout N shortcut setting', () => {
  it('does nothing on N when the shortcut is turned off in Settings', async () => {
    writePreferences(window.localStorage, { ...DEFAULT_PREFERENCES, shortcutN: false });
    renderLayout();
    await userEvent.setup().keyboard('n');
    expect(screen.queryByText('Add sheet open')).not.toBeInTheDocument();
  });

  it('only mentions N on the add button tooltip while the shortcut is on', async () => {
    writePreferences(window.localStorage, { ...DEFAULT_PREFERENCES, shortcutN: false });
    const user = userEvent.setup();
    renderLayout();
    await user.hover(within(screen.getByRole('banner')).getByRole('button', { name: 'Add transaction' }));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Add transaction');
    expect(tooltip).not.toHaveTextContent('(N)');
  });
});

describe('DefaultLayout ended session', () => {
  it('replaces the page when a request finds the session can no longer be renewed', () => {
    renderLayout(<p>Could not load your budget</p>);

    act(() => markSessionEnded());

    expect(screen.getByRole('heading', { name: 'Your session has ended' })).toBeInTheDocument();
    expect(screen.queryByText('Could not load your budget')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add transaction' })).not.toBeInTheDocument();
  });
});

describe('DefaultLayout signed out', () => {
  beforeEach(() => {
    auth.isAuthenticated = false;
  });

  it('replaces the page with a signed-out panel and hides the add button', () => {
    renderLayout(<p>Income this month £0.00</p>);

    expect(screen.getByRole('heading', { name: "You're signed out" })).toBeInTheDocument();
    expect(screen.getByText('Your data is safe. Sign in to see it.')).toBeInTheDocument();
    expect(screen.queryByText('Income this month £0.00')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add transaction' })).not.toBeInTheDocument();
  });

  it('says how long you stay signed in, and makes the panel the page\'s one h1', () => {
    renderLayout();
    expect(screen.getByText(SESSION_LIFETIME_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: "You're signed out" })).toBeInTheDocument();
  });

  it('starts sign-in from the panel button', async () => {
    renderLayout();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(auth.loginWithRedirect).toHaveBeenCalled();
  });

  it('does not open the add sheet on N', async () => {
    renderLayout();
    await userEvent.setup().keyboard('n');
    expect(screen.queryByText('Add sheet open')).not.toBeInTheDocument();
  });

  it('says the session has ended when Auth0 needs a new sign-in', () => {
    auth.error = authError('login_required');
    renderLayout();

    expect(screen.getByRole('heading', { name: 'Your session has ended' })).toBeInTheDocument();
    expect(screen.getByText('Your data is safe. Sign in to see it.')).toBeInTheDocument();
    expect(screen.queryByText(/raw provider detail/)).not.toBeInTheDocument();
  });

  it('says the session has ended when a signed-in session goes away', () => {
    auth.isAuthenticated = true;
    const view = renderLayout();

    auth.isAuthenticated = false;
    view.rerender(
      <MantineProvider>
        <MemoryRouter>
          <DefaultLayout><p>page</p></DefaultLayout>
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Your session has ended' })).toBeInTheDocument();
  });

  it('shows a loading indicator instead of the page while the session is checked', () => {
    auth.isLoading = true;
    renderLayout(<p>Income this month £0.00</p>);

    expect(screen.getByRole('status', { name: 'Checking your session' })).toBeInTheDocument();
    expect(screen.queryByText('Income this month £0.00')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "You're signed out" })).not.toBeInTheDocument();
  });
});

describe('DefaultLayout navigation keeps the month', () => {
  function hrefsFor(name: string): (string | null)[] {
    return screen.getAllByRole('link', { name }).map(link => link.getAttribute('href'));
  }

  it('carries the viewed month to the pages that show one', () => {
    renderLayout(<p>page</p>, '/transactions?month=2026-08');
    for (const name of ['Home', 'Transactions', 'Insights']) {
      const expected = name === 'Home' ? '/?month=2026-08' : `/${name.toLowerCase()}?month=2026-08`;
      expect(hrefsFor(name)).toContain(expected);
      expect(hrefsFor(name).every(href => href === expected)).toBe(true);
    }
  });

  it('leaves pages without a month alone', () => {
    renderLayout(<p>page</p>, '/?month=2026-08');
    expect(hrefsFor('Plan').every(href => href === '/plan')).toBe(true);
  });

  it('adds nothing when no month is selected', () => {
    renderLayout(<p>page</p>, '/');
    expect(hrefsFor('Transactions').every(href => href === '/transactions')).toBe(true);
  });
});

describe('DefaultLayout public pages', () => {
  it('shows /about to someone who is signed out, not the sign-in panel', () => {
    auth.isAuthenticated = false;
    renderLayout(<p>about content</p>, '/about');
    expect(screen.getByText('about content')).toBeInTheDocument();
    expect(screen.queryByText("You're signed out")).not.toBeInTheDocument();
  });

  it('still gates other pages when signed out', () => {
    auth.isAuthenticated = false;
    renderLayout(<p>private content</p>, '/transactions');
    expect(screen.queryByText('private content')).not.toBeInTheDocument();
    expect(screen.getByText("You're signed out")).toBeInTheDocument();
  });

  it('matches /about with a trailing slash', () => {
    auth.isAuthenticated = false;
    renderLayout(<p>about content</p>, '/about/');
    expect(screen.getByText('about content')).toBeInTheDocument();
  });

  it('does not treat a path that only starts with /about as public', () => {
    auth.isAuthenticated = false;
    renderLayout(<p>private content</p>, '/about-me');
    expect(screen.queryByText('private content')).not.toBeInTheDocument();
  });

  it('shows /about straight away while Auth0 is still loading, with no spinner', () => {
    auth.isAuthenticated = false;
    auth.isLoading = true;
    renderLayout(<p>about content</p>, '/about');
    expect(screen.getByText('about content')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Checking your session' })).not.toBeInTheDocument();
  });

  it('shows /about, not "Your session has ended", after a session has ended', () => {
    auth.isAuthenticated = false;
    auth.error = authError('login_required');
    renderLayout(<p>about content</p>, '/about');
    expect(screen.getByText('about content')).toBeInTheDocument();
    expect(screen.queryByText('Your session has ended')).not.toBeInTheDocument();
  });

  it('shows /about to a signed-in person too, and keeps the Add button for them', () => {
    renderLayout(<p>about content</p>, '/about');
    expect(screen.getByText('about content')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add transaction' }).length).toBeGreaterThan(0);
  });
});

describe('DefaultLayout sign-in panel links', () => {
  it('links from the signed-out panel to /about', () => {
    auth.isAuthenticated = false;
    renderLayout(<p>private content</p>, '/');
    expect(screen.getByRole('link', { name: 'See what it looks like' })).toHaveAttribute('href', '/about');
  });

  it('links from the session-ended panel to /about as well', () => {
    auth.isAuthenticated = false;
    auth.error = authError('login_required');
    renderLayout(<p>private content</p>, '/');
    expect(screen.getByRole('link', { name: 'See what it looks like' })).toHaveAttribute('href', '/about');
  });
});

describe('DefaultLayout connection request across sign-in', () => {
  const CONNECT = '/connect?response_type=code&client_id=c&state=s';

  it('keeps the whole /connect request while signed out', () => {
    auth.isAuthenticated = false;
    renderLayout(<p>page</p>, CONNECT);
    expect(takeConnectReturn()).toBe(CONNECT);
  });

  it('does not keep other pages', () => {
    auth.isAuthenticated = false;
    renderLayout(<p>page</p>, '/settings?x=1');
    expect(takeConnectReturn()).toBeUndefined();
  });

  it('sends a visitor back to it when they arrive signed in on the home page', () => {
    rememberConnectReturn(CONNECT);
    function Where() {
      const { pathname, search } = useLocation();
      return <p data-testid="where">{pathname + search}</p>;
    }
    renderLayout(<Where />, '/');
    expect(screen.getByTestId('where')).toHaveTextContent(CONNECT);
    expect(takeConnectReturn()).toBeUndefined();
  });

  it('leaves it alone on other pages', () => {
    rememberConnectReturn(CONNECT);
    renderLayout(<p>page</p>, '/settings');
    expect(takeConnectReturn()).toBe(CONNECT);
  });
});
