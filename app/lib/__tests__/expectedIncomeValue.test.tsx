import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const auth0 = {
  isAuthenticated: true,
  isLoading: false,
  getAccessTokenSilently: vi.fn(async () => 'token'),
};

vi.mock('@auth0/auth0-react', () => ({ useAuth0: () => auth0 }));

import { useExpectedIncomeValue } from '../queries';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function respondWith(amount: number | null): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ amount }))));
}

describe('useExpectedIncomeValue', () => {
  beforeEach(() => {
    auth0.isAuthenticated = true;
    auth0.isLoading = false;
  });

  it('is null while the override is loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { result } = renderHook(() => useExpectedIncomeValue(200000), { wrapper });
    expect(result.current).toBeNull();
  });

  it('is null when the override failed to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const { result } = renderHook(() => useExpectedIncomeValue(200000), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBeNull();
  });

  it('is the override when one is saved', async () => {
    respondWith(250000);
    const { result } = renderHook(() => useExpectedIncomeValue(200000), { wrapper });
    await waitFor(() => expect(result.current).toBe(250000));
  });

  it('is the regular figure when there is no override', async () => {
    respondWith(null);
    const { result } = renderHook(() => useExpectedIncomeValue(200000), { wrapper });
    await waitFor(() => expect(result.current).toBe(200000));
  });

  it('is null when neither exists', async () => {
    respondWith(null);
    const { result } = renderHook(() => useExpectedIncomeValue(null), { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBeNull();
  });
});
