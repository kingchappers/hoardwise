import { LOOPBACK_HOSTS } from './types';

// The public origin the discovery documents advertise. It comes from configuration only, never from a request.
// Unset or invalid means OAuth is disabled; the warning never includes the value, which could carry a credential.
export function oauthOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.APP_ORIGIN?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const secure = url.protocol === 'https:';
    const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
    const plain = url.username === '' && url.password === '' && url.search === '' && url.hash === '' && url.pathname === '/'
      && !raw.includes('?') && !raw.includes('#');
    if ((secure || loopback) && plain) return url.origin;
  } catch {
    // Falls through to the warning.
  }
  console.warn('APP_ORIGIN is not a plain https origin (http only for loopback): OAuth sign-in is disabled');
  return undefined;
}

let resolvedFrom: string | undefined;
let resolved: string | undefined;

// Read at request time, not at import, so the container can set APP_ORIGIN (it may derive it from TLS_DOMAIN) first.
// Re-resolved only when the variable changes, so an invalid value warns once.
export function resolvePublicOrigin(): string | undefined {
  const raw = process.env.APP_ORIGIN;
  if (resolvedFrom !== raw) {
    resolved = oauthOrigin(process.env);
    resolvedFrom = raw;
  }
  return resolved;
}
