import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { MAX_PASSWORD_LENGTH } from '../auth/password';
import { getClient, touchClient } from '../oauth/clients';
import type { OAuthClient } from '../oauth/clients';
import { issueCode } from '../oauth/codes';
import { resolvePublicOrigin } from '../oauth/config';
import type { OAuthScope } from '../oauth/types';
import { getStore } from '../store';
import { err, noStore, ok, parseJsonObject } from './http';
import { checkPassword, needsPassword } from './passwordGate';
import type { ApiResponse } from './types';

const ALLOWED_FIELDS = ['client_id', 'redirect_uri', 'scope', 'code_challenge', 'state', 'password'];
// S256 of a 32-byte verifier is 43 base64url characters.
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_STATE_LENGTH = 512;
const MAX_FIELD_LENGTH = 2000;
const NOT_FOUND = 'Not found';

interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scope: OAuthScope;
  codeChallenge: string;
  state: string | undefined;
  password: string | undefined;
}

type Validation = { ok: true; value: AuthorizeRequest } | { ok: false; message: string };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function validateAuthorize(body: Record<string, unknown>): Validation {
  if (!Object.keys(body).every((key) => ALLOWED_FIELDS.includes(key))) {
    return { ok: false, message: 'Unexpected fields in the request' };
  }
  const { client_id: clientId, redirect_uri: redirectUri, scope, code_challenge: codeChallenge, state, password } = body;
  if (!isShortString(clientId)) return { ok: false, message: 'client_id is required' };
  if (!isShortString(redirectUri)) return { ok: false, message: 'redirect_uri is required' };
  if (scope !== 'read' && scope !== 'write') return { ok: false, message: "scope must be 'read' or 'write'" };
  if (typeof codeChallenge !== 'string' || !CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
    return { ok: false, message: 'code_challenge must be a 43-character base64url S256 challenge' };
  }
  if (state !== undefined && (typeof state !== 'string' || state.length > MAX_STATE_LENGTH)) {
    return { ok: false, message: `state must be a string of at most ${MAX_STATE_LENGTH} characters` };
  }
  if (password !== undefined && (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH)) {
    return { ok: false, message: `password must be a string of at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  return { ok: true, value: { clientId, redirectUri, scope, codeChallenge, state, password } };
}

// The client only when the redirect is, character for character, one it registered. Anything else is not
// distinguished: an unknown client and an unregistered redirect look the same.
async function registeredClient(clientId: unknown, redirectUri: unknown): Promise<OAuthClient | undefined> {
  if (typeof clientId !== 'string' || typeof redirectUri !== 'string') return undefined;
  const client = await getClient(getStore(), clientId, nowSeconds());
  if (!client || !client.redirectUris.includes(redirectUri)) return undefined;
  return client;
}

export async function getOauthClient(
  event: APIGatewayProxyEventV2,
  _userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  if (!resolvePublicOrigin()) return noStore(err(404, NOT_FOUND));
  const query = event.queryStringParameters ?? {};
  const client = await registeredClient(query.client_id, query.redirect_uri);
  if (!client) return noStore(err(404, NOT_FOUND));
  const redirectUri = query.redirect_uri as string;
  return noStore(ok({ name: client.name, redirectHost: new URL(redirectUri).host, redirectUri }));
}

async function authorize(event: APIGatewayProxyEventV2, userId: string): Promise<ApiResponse> {
  if (!resolvePublicOrigin()) return err(404, NOT_FOUND);
  const body = parseJsonObject(event);
  if (!body) return err(400, 'Invalid JSON');
  const validation = validateAuthorize(body);
  if (validation.ok === false) return err(400, validation.message);
  const { clientId, redirectUri, scope, codeChallenge, state, password } = validation.value;

  // Checked before the password so a wrong client cannot be used to spend password guesses.
  if (!(await registeredClient(clientId, redirectUri))) return err(404, NOT_FOUND);

  const store = getStore();
  if (needsPassword(scope)) {
    const refusal = await checkPassword(store, password);
    if (refusal) return refusal;
  }

  const now = nowSeconds();
  const code = await issueCode(store, { clientId, userId, scope, redirectUri, codeChallenge }, now);
  await touchClient(store, clientId, now);

  const redirectTo = new URL(redirectUri);
  redirectTo.searchParams.set('code', code);
  if (state !== undefined) redirectTo.searchParams.set('state', state);
  console.log('OAuth consent granted:', clientId, scope);
  return ok({ redirectTo: redirectTo.toString() });
}

export async function authorizeOauthClient(
  event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  return noStore(await authorize(event, userId));
}
