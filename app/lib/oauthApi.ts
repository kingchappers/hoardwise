// Kept apart from api.ts so the browser demo, which never shows the connection page, carries none of it.
type Request = (endpoint: string, options?: RequestInit) => Promise<unknown>;

export type ConnectScope = 'read' | 'write';

export interface OauthClientInfo {
  name: string;
  redirectHost: string;
  redirectUri: string;
}

export interface AuthorizeInput {
  clientId: string;
  redirectUri: string;
  scope: ConnectScope;
  codeChallenge: string;
  state?: string;
  password?: string;
}

export function createOauthApi(request: Request) {
  return {
    getClient: async (clientId: string, redirectUri: string): Promise<OauthClientInfo> => {
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri });
      return await request(`/api/oauth/client?${query.toString()}`) as OauthClientInfo;
    },
    authorize: async (input: AuthorizeInput): Promise<{ redirectTo: string }> => {
      const body = {
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        scope: input.scope,
        code_challenge: input.codeChallenge,
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.password !== undefined ? { password: input.password } : {}),
      };
      return await request('/api/oauth/authorize', { method: 'POST', body: JSON.stringify(body) }) as { redirectTo: string };
    },
  };
}
