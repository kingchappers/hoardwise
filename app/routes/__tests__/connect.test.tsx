import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

vi.mock('~/components/layout/DefaultLayout', () => ({
  DefaultLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('~/demo/flag', () => ({ isDemo: true }));

import Connect from '../connect';

describe('Connect route in the demo', () => {
  it('says it is not available and offers no consent', () => {
    render(<MantineProvider><Connect /></MantineProvider>);
    expect(screen.getByText('Connecting an app is not available in the demo.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });
});
