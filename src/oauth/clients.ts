import { randomBytes } from 'node:crypto';
import type { Item, Store } from '../store';
import {
  MAX_CLIENTS, MAX_CLIENT_NAME_LENGTH, MAX_REDIRECT_URIS, MAX_REDIRECT_URI_LENGTH, UNUSED_CLIENT_TTL_SECONDS,
  USED_CLIENT_TTL_SECONDS, isLive,
} from './types';

const CLIENTS_PK = 'OAUTH#CLIENTS';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: number;
}

export class ClientLimitError extends Error {
  constructor() {
    super(`At most ${MAX_CLIENTS} OAuth clients can be registered`);
    this.name = 'ClientLimitError';
  }
}

export class InvalidRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRedirectError';
  }
}

function checkRedirectUri(uri: unknown): string {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_REDIRECT_URI_LENGTH) {
    throw new InvalidRedirectError('Each redirect URI must be a string of at most 2000 characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new InvalidRedirectError('A redirect URI is not a valid URL');
  }
  if (parsed.hash !== '' || uri.includes('#')) throw new InvalidRedirectError('A redirect URI must not have a fragment');
  if (parsed.username !== '' || parsed.password !== '') throw new InvalidRedirectError('A redirect URI must not have credentials');
  const secure = parsed.protocol === 'https:';
  const loopback = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  if (!secure && !loopback) throw new InvalidRedirectError('A redirect URI must be https, or http on a loopback address');
  return uri;
}

function toClient(item: Item): OAuthClient {
  return {
    clientId: String(item.SK),
    name: String(item.name),
    redirectUris: (item.redirectUris as string[]).slice(),
    createdAt: Number(item.createdAt),
  };
}

export async function registerClient(
  store: Store,
  input: { name: string; redirectUris: string[] },
  nowSeconds: number,
): Promise<OAuthClient> {
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0 || input.redirectUris.length > MAX_REDIRECT_URIS) {
    throw new InvalidRedirectError(`Between 1 and ${MAX_REDIRECT_URIS} redirect URIs are required`);
  }
  const redirectUris = input.redirectUris.map(checkRedirectUri);

  const live = (await store.query(CLIENTS_PK, { attributes: ['expiresAt'] })).filter((item) => isLive(item, nowSeconds));
  if (live.length >= MAX_CLIENTS) throw new ClientLimitError();

  const client: OAuthClient = {
    clientId: randomBytes(16).toString('base64url'),
    name: String(input.name ?? '').trim().slice(0, MAX_CLIENT_NAME_LENGTH),
    redirectUris,
    createdAt: nowSeconds,
  };
  await store.put({
    PK: CLIENTS_PK,
    SK: client.clientId,
    name: client.name,
    redirectUris,
    createdAt: nowSeconds,
    expiresAt: nowSeconds + UNUSED_CLIENT_TTL_SECONDS,
  }, { ifAbsent: true });
  return client;
}

export async function getClient(store: Store, clientId: string, nowSeconds: number): Promise<OAuthClient | undefined> {
  const item = await store.get({ PK: CLIENTS_PK, SK: clientId });
  if (!item || !isLive(item, nowSeconds)) return undefined;
  return toClient(item);
}

export async function touchClient(store: Store, clientId: string, nowSeconds: number): Promise<void> {
  if (!(await getClient(store, clientId, nowSeconds))) return;
  await store.patch({ PK: CLIENTS_PK, SK: clientId }, { expiresAt: nowSeconds + USED_CLIENT_TTL_SECONDS }, { mustExist: true });
}
