const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ConnectParams {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
}

// Everything the page checks before it asks the server anything. undefined means the request is not one we will act on.
export function parseConnectParams(search: URLSearchParams): ConnectParams | undefined {
  const clientId = search.get('client_id');
  const redirectUri = search.get('redirect_uri');
  const codeChallenge = search.get('code_challenge');
  if (!clientId || !redirectUri || !codeChallenge) return undefined;
  if (search.get('response_type') !== 'code') return undefined;
  if (search.get('code_challenge_method') !== 'S256') return undefined;
  if (!CODE_CHALLENGE_PATTERN.test(codeChallenge)) return undefined;
  try {
    new URL(redirectUri);
  } catch {
    return undefined;
  }
  return { clientId, redirectUri, state: search.get('state') ?? undefined, codeChallenge };
}

// Defence in depth: the server builds redirectTo from the registered redirect_uri, but the page still insists on it
// (same origin and path, nothing but the code and state added to the query).
export function isRedirectToAllowed(redirectTo: unknown, redirectUri: string): redirectTo is string {
  if (typeof redirectTo !== 'string') return false;
  try {
    const target = new URL(redirectTo);
    const expected = new URL(redirectUri);
    return target.origin === expected.origin && target.pathname === expected.pathname && target.hash === expected.hash;
  } catch {
    return false;
  }
}
