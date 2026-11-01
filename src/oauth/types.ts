import type { TokenScope } from '../auth/tokens';

export type OAuthScope = TokenScope;

export const REFRESH_PK = 'OAUTH#REFRESH';
// A rotated refresh token leaves a tombstone here until its own expiry, so a replay is recognised as reuse.
export const REFRESH_USED_PK = 'OAUTH#REFRESH-USED';

export const CODE_TTL_SECONDS = 60;
export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_SECONDS = 90 * 86400;
export const MAX_CLIENTS = 500;
export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_URI_LENGTH = 2000;
export const MAX_CLIENT_NAME_LENGTH = 60;
export const UNUSED_CLIENT_TTL_SECONDS = 7 * 86400;
export const USED_CLIENT_TTL_SECONDS = 90 * 86400;

// Rows carry expiresAt, the table's TTL attribute. The purge is hourly, so a read must also check it.
export function isLive(item: Record<string, unknown>, nowSeconds: number): boolean {
  return typeof item.expiresAt === 'number' && item.expiresAt > nowSeconds;
}
