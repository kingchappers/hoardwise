import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { ApiError } from '~/lib/apiError';
import { expectNoViolations, expectSoundHeadings } from '~/test-utils/accessibility';

const state = vi.hoisted(() => ({
  mode: 'auth0' as 'auth0' | 'local',
  client: { data: undefined as unknown, isLoading: false, error: null as Error | null, refetch: vi.fn() },
  authorize: vi.fn(),
  navigateExternal: vi.fn(),
  clientArgs: [] as unknown[],
}));

vi.mock('~/lib/auth', () => ({ useAuth: () => ({ mode: state.mode, isAuthenticated: true }) }));
vi.mock('~/lib/oauthQueries', () => ({
  useOauthClient: (...args: unknown[]) => { state.clientArgs = args; return state.client; },
  useAuthorizeClient: () => ({ mutateAsync: state.authorize, isPending: false }),
}));
vi.mock('~/lib/navigateExternal', () => ({ navigateExternal: state.navigateExternal }));

import { ConsentScreen } from '../ConsentScreen';

const CHALLENGE = 'A'.repeat(43);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function query(overrides: Record<string, string | null> = {}): string {
  const base: Record<string, string> = {
    response_type: 'code',
    client_id: 'client-1',
    redirect_uri: REDIRECT,
    state: 'xyz',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  };
  const params = new URLSearchParams();
  Object.entries({ ...base, ...overrides }).forEach(([key, value]) => { if (value !== null) params.set(key, value); });
  return params.toString();
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderPage(search: string = query()) {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[`/connect?${search}`]}>
        <Where />
        <Routes>
          <Route path="/connect" element={<ConsentScreen />} />
          <Route path="/" element={<p>Home</p>} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
}

function clientFound(name = 'Claude') {
  state.client = { data: { name, redirectHost: 'claude.ai', redirectUri: REDIRECT }, isLoading: false, error: null, refetch: vi.fn() };
}

const INVALID = /This connection request isn't valid/;

beforeEach(() => {
  state.mode = 'auth0';
  state.authorize.mockReset();
  state.navigateExternal.mockReset();
  clientFound();
});

describe('ConsentScreen', () => {
  it('names the client and the redirect host as plain text', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Claude wants to connect to your Hoardwise');
    expect(screen.getByText(/It will send you back to claude\.ai/)).toBeInTheDocument();
  });

  it('shows an HTML-looking client name literally', () => {
    clientFound('<img src=x onerror=alert(1)>');
    const { container } = renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('<img src=x onerror=alert(1)> wants to connect');
    expect(container.querySelector('img')).toBeNull();
  });

  it('looks the client up with the validated parameters', () => {
    renderPage();
    expect(state.clientArgs).toEqual(['client-1', REDIRECT]);
  });

  it('defaults to View only', () => {
    renderPage();
    expect(screen.getByRole('radio', { name: /View only/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /View and change/ })).not.toBeChecked();
    expect(screen.getByText('It can look at your budget and keep your chart styles')).toBeInTheDocument();
    expect(screen.getByText('It can also add spends and incomes when you say yes')).toBeInTheDocument();
  });

  it('asks for the password only in local mode with View and change', async () => {
    const user = userEvent.setup();
    state.mode = 'local';
    renderPage();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    await user.click(screen.getByRole('radio', { name: /View and change/ }));
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /View only/ }));
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it('never asks for a password with Auth0', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('radio', { name: /View and change/ }));
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it.each([
    ['plain challenge method', { code_challenge_method: 'plain' }],
    ['missing challenge', { code_challenge: null }],
    ['short challenge', { code_challenge: 'abc' }],
    ['padded challenge', { code_challenge: `${'A'.repeat(42)}=` }],
    ['wrong response type', { response_type: 'token' }],
    ['missing client', { client_id: null }],
    ['missing redirect', { redirect_uri: null }],
    ['unparseable redirect', { redirect_uri: 'not a url' }],
  ])('shows the error state for a %s and calls nothing', (_name, overrides) => {
    renderPage(query(overrides));
    expect(screen.getByText(INVALID)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(state.clientArgs).toEqual([undefined, undefined]);
    expect(state.authorize).not.toHaveBeenCalled();
    expect(state.navigateExternal).not.toHaveBeenCalled();
  });

  it('shows the error state when the client is not found', () => {
    state.client = { data: undefined, isLoading: false, error: new ApiError(404, 'Not Found'), refetch: vi.fn() };
    renderPage();
    expect(screen.getByText(INVALID)).toBeInTheDocument();
    expect(state.authorize).not.toHaveBeenCalled();
    expect(state.navigateExternal).not.toHaveBeenCalled();
  });

  it('says so, with a retry, when the lookup fails for another reason', async () => {
    const user = userEvent.setup();
    state.client = { data: undefined, isLoading: false, error: new ApiError(500, 'Server Error'), refetch: vi.fn() };
    renderPage();
    expect(screen.queryByText(INVALID)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(state.client.refetch).toHaveBeenCalled();
  });

  it('waits while the client is loading', () => {
    state.client = { data: undefined, isLoading: true, error: null, refetch: vi.fn() };
    renderPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('Cancel goes home without authorizing or redirecting', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/');
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(state.authorize).not.toHaveBeenCalled();
    expect(state.navigateExternal).not.toHaveBeenCalled();
  });

  it('sends read scope, the challenge and the state, then follows redirectTo', async () => {
    const user = userEvent.setup();
    const redirectTo = `${REDIRECT}?code=abc&state=xyz`;
    state.authorize.mockResolvedValue({ redirectTo });
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(state.navigateExternal).toHaveBeenCalledWith(redirectTo));
    expect(state.authorize).toHaveBeenCalledWith({
      clientId: 'client-1', redirectUri: REDIRECT, scope: 'read', codeChallenge: CHALLENGE, state: 'xyz',
    });
    expect(screen.getByText('Connected. You can go back to Claude.')).toBeInTheDocument();
  });

  it('sends the password with View and change in local mode', async () => {
    const user = userEvent.setup();
    state.mode = 'local';
    state.authorize.mockResolvedValue({ redirectTo: `${REDIRECT}?code=abc` });
    renderPage();
    await user.click(screen.getByRole('radio', { name: /View and change/ }));
    await user.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(state.authorize).toHaveBeenCalled());
    expect(state.authorize).toHaveBeenCalledWith(expect.objectContaining({ scope: 'write', password: 'hunter2hunter2' }));
  });

  it('asks for the password before calling when it is empty', async () => {
    const user = userEvent.setup();
    state.mode = 'local';
    renderPage();
    await user.click(screen.getByRole('radio', { name: /View and change/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByText('Enter your password to continue.')).toBeInTheDocument();
    expect(state.authorize).not.toHaveBeenCalled();
  });

  it('does not follow a redirectTo that is not the validated redirect_uri', async () => {
    const user = userEvent.setup();
    state.authorize.mockResolvedValue({ redirectTo: 'https://evil.example/steal?code=abc' });
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(state.navigateExternal).not.toHaveBeenCalled();
  });

  it.each([
    [403, "That password isn't right. Try again."],
    [429, 'Too many attempts. Wait a few minutes, then try again.'],
    [404, INVALID],
    [500, "Couldn't connect. Nothing was shared. Try again."],
  ])('shows a calm message for a %s and stays on the page', async (status, message) => {
    const user = userEvent.setup();
    state.mode = 'local';
    state.authorize.mockRejectedValue(new ApiError(status, 'x'));
    renderPage();
    await user.click(screen.getByRole('radio', { name: /View and change/ }));
    await user.type(screen.getByLabelText(/password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(state.navigateExternal).not.toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('/connect');
  });

  it('can be used with the keyboard alone', async () => {
    const user = userEvent.setup();
    state.authorize.mockResolvedValue({ redirectTo: `${REDIRECT}?code=abc` });
    renderPage();
    await user.tab();
    expect(screen.getByRole('radio', { name: /View only/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: /View and change/ })).toBeChecked();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(state.authorize).toHaveBeenCalledWith(expect.objectContaining({ scope: 'write' })));
  });

  it('moves focus to the heading on load', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  it('has named controls and sound headings', async () => {
    const { container } = renderPage();
    expect(screen.getByRole('radiogroup', { name: /What can it do/ })).toBeInTheDocument();
    expectSoundHeadings(container);
    await expectNoViolations(container);
  });
});
