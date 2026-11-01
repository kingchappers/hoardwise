import { ApiError } from '~/lib/apiError';
import { formatShortDate, todayIso } from '~/lib/months';
import type { AccessToken, AccessTokenExpiryDays, AccessTokenScope } from '~/lib/types';

export const SCOPE_LABELS: Record<AccessTokenScope, string> = {
  read: 'Read only',
  write: 'Read and write',
};

export const EXPIRY_OPTIONS = [
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '365 days' },
  { value: '730', label: '730 days' },
  { value: 'never', label: 'Never' },
];

export const NEVER = 'never';

export function expiryDaysFor(value: string): AccessTokenExpiryDays {
  if (value === NEVER) return null;
  return Number(value) as Exclude<AccessTokenExpiryDays, null>;
}

// Epoch seconds to "14 Feb 2027", in local time.
export function formatTokenDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${formatShortDate(todayIso(date))} ${date.getFullYear()}`;
}

function nowInSeconds(): number {
  return Date.now() / 1000;
}

// The list still returns expired tokens until they are purged, and they still count toward the limit.
export function isExpired(token: AccessToken, nowSeconds: number = nowInSeconds()): boolean {
  return token.expiresAt !== null && token.expiresAt <= nowSeconds;
}

export function expiryText(token: AccessToken, nowSeconds: number = nowInSeconds()): string {
  if (isConnection(token)) return connectionExpiryText(token, nowSeconds);
  if (token.expiresAt === null) return 'Never expires';
  if (isExpired(token, nowSeconds)) return `Expired ${formatTokenDate(token.expiresAt)}`;
  return `Expires ${formatTokenDate(token.expiresAt)}`;
}

export function isConnection(token: AccessToken): boolean {
  return token.kind === 'oauth';
}

// A connection's expiry is when it lapses unless the assistant keeps using it.
export function connectionExpiryText(token: AccessToken, nowSeconds: number = nowInSeconds()): string {
  if (token.expiresAt === null) return 'Connected';
  if (isExpired(token, nowSeconds)) return `Connection ended ${formatTokenDate(token.expiresAt)}`;
  return `Connected until ${formatTokenDate(token.expiresAt)}`;
}

export function lastUsedText(token: AccessToken): string {
  if (token.lastUsedAt === null) return 'Never used';
  return `Last used ${formatTokenDate(token.lastUsedAt)}`;
}

export const NAME_CONTROL_CHARACTERS = "Check the name and try again. It can't contain tabs or other control characters.";

// Mirrors the server's check, so a name it would reject is caught before sending.
export function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

const CREATE_ERRORS: Record<number, string> = {
  400: NAME_CONTROL_CHARACTERS,
  403: "You don't have permission to create a token right now. Reload the page and try again.",
  409: 'You have 25 access tokens, the most allowed. Revoke one to make room.',
  429: 'Too many attempts. Wait a little and try again.',
};

const WRONG_PASSWORD = "That password wasn't right.";
const CREATE_FAILED = "Couldn't create the token. Check your connection and try again.";

// A 403 also covers a failed Origin check, so it only means a wrong password when one was sent.
export function createErrorText(error: unknown, sentPassword: boolean): string {
  if (!(error instanceof ApiError)) return CREATE_FAILED;
  if (error.status === 403 && sentPassword) return WRONG_PASSWORD;
  return CREATE_ERRORS[error.status] ?? CREATE_FAILED;
}
