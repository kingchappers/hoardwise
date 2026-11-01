import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { expectNoViolations, expectSoundHeadings } from '~/test-utils/accessibility';
import { AiAssistants } from '../AiAssistants';

const MCP_URL = `${window.location.origin}/mcp`;

function renderSection() {
  return render(
    <MantineProvider>
      <h1>Settings</h1>
      <AiAssistants />
    </MantineProvider>,
  );
}

describe('AiAssistants', () => {
  it('shows this Hoardwise address with /mcp on the end', () => {
    renderSection();
    expect(screen.getByLabelText('Your Hoardwise address')).toHaveValue(MCP_URL);
  });

  it('copies the address', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(MCP_URL);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('says so when the address could not be copied', async () => {
    const user = userEvent.setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderSection();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('status')).toHaveTextContent("Couldn't copy automatically");
  });

  it('gives steps for Claude on the web or desktop and says what the phone app does', () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Claude on the web or desktop' })).toBeInTheDocument();
    expect(screen.getByText(/Settings → Connectors → Add custom connector/)).toBeInTheDocument();
    expect(screen.getByText(/phone app shows connectors you add on the web or desktop/)).toBeInTheDocument();
  });

  it('says what the sign-in needs on the instance', () => {
    renderSection();
    expect(screen.getByText(/self-hosters: set APP_ORIGIN/)).toBeInTheDocument();
  });

  it('gives the Claude Code command with the real address and a placeholder token', () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.getByText(`claude mcp add --transport http hoardwise ${MCP_URL} --header "Authorization: Bearer <your token>"`)).toBeInTheDocument();
  });

  it('covers other apps that support remote MCP', () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Cursor, ChatGPT and other apps that support remote MCP' })).toBeInTheDocument();
  });

  it('keeps the developer example behind a disclosure, with the headers it needs', async () => {
    renderSection();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'For developers and self-hosters' }));
    const curl = screen.getByText(/^curl -sS /);
    expect(curl).toHaveTextContent(MCP_URL);
    expect(curl).toHaveTextContent('Accept: application/json, text/event-stream');
    expect(curl).toHaveTextContent('Content-Type: application/json');
    expect(curl).toHaveTextContent('$TOKEN');
    expect(screen.getByText(/missing Accept or Content-Type header is refused/)).toBeInTheDocument();
  });

  it('never shows a real token', () => {
    const { container } = renderSection();
    expect(container.textContent).not.toMatch(/hw[rw]_[A-Za-z0-9]/);
  });

  it('has sound headings and no accessibility violations', async () => {
    const { container } = renderSection();
    expectSoundHeadings(container);
    await expectNoViolations(container);
    within(container).getByRole('heading', { name: 'AI assistants' });
  });
});
