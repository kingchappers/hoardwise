// A visitor who is signed out when they reach /connect goes through sign-in, which can leave the page (Auth0 returns to the
// home page). The exact /connect path and query is kept in sessionStorage for a short while so they can be sent back to it.
const KEY = 'hoardwise.connectReturn';
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_LENGTH = 8000;

// Only a same-origin /connect path (optionally with a query) is ever accepted, so this cannot become an open redirect.
export function isSafeConnectPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return false;
  if (value !== '/connect' && !value.startsWith('/connect?')) return false;
  return !/[\\\s\u0000-\u001f]/.test(value) && !value.includes('#');
}

export function rememberConnectReturn(pathWithQuery: string, now: number = Date.now()): void {
  if (!isSafeConnectPath(pathWithQuery)) return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ path: pathWithQuery, at: now }));
  } catch (error) {
    console.error('Could not remember the connection request across sign-in:', error);
  }
}

export function clearConnectReturn(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch (error) {
    console.error('Could not clear the remembered connection request:', error);
  }
}

// The remembered path once, or undefined if there is none, it is stale, or it is not a safe /connect path.
export function takeConnectReturn(now: number = Date.now()): string | undefined {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch (error) {
    console.error('Could not read the remembered connection request:', error);
    return undefined;
  }
  if (raw === null) return undefined;
  clearConnectReturn();
  try {
    const parsed = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof parsed.at !== 'number' || now - parsed.at > MAX_AGE_MS || now < parsed.at) return undefined;
    return isSafeConnectPath(parsed.path) ? parsed.path : undefined;
  } catch {
    return undefined;
  }
}
