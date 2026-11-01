import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useProtectedApi } from '~/hooks/useProtectedApi';
import { useAuth } from '~/lib/auth';
import { ApiError } from '~/lib/apiError';
import { createOauthApi, type AuthorizeInput, type OauthClientInfo } from './oauthApi';

function useOauthApi() {
  const { request } = useProtectedApi();
  return useMemo(() => createOauthApi(request), [request]);
}

export function useOauthClient(clientId: string | undefined, redirectUri: string | undefined) {
  const api = useOauthApi();
  const signedIn = useAuth().isAuthenticated;
  return useQuery<OauthClientInfo, Error>({
    queryKey: ['oauthClient', clientId, redirectUri],
    queryFn: () => api.getClient(clientId as string, redirectUri as string),
    enabled: signedIn && clientId !== undefined && redirectUri !== undefined,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
    staleTime: Infinity,
    gcTime: 0,
  });
}

// gcTime 0 drops the mutation, and the password in it, once the page unmounts.
export function useAuthorizeClient() {
  const api = useOauthApi();
  return useMutation<{ redirectTo: string }, Error, AuthorizeInput>({
    mutationFn: (input) => api.authorize(input),
    gcTime: 0,
  });
}
