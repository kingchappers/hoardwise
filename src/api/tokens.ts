import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { MAX_PASSWORD_LENGTH } from '../auth/password';
import {
  MAX_TOKEN_NAME_LENGTH, TOKEN_EXPIRY_DAYS, TokenLimitError, createToken, listTokens, revokeToken,
} from '../auth/tokens';
import type { TokenScope } from '../auth/tokens';
import { getStore } from '../store';
import { SECURITY_HEADERS } from './constants';
import { err, noStore, ok, parseJsonObject } from './http';
import { checkPassword, needsPassword } from './passwordGate';
import type { ApiResponse } from './types';

const ALLOWED_FIELDS = ['name', 'scope', 'expiryDays', 'password'];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPIRY_DAYS: readonly number[] = TOKEN_EXPIRY_DAYS;

interface CreateRequest {
  name: string;
  scope: TokenScope;
  expiryDays: number | null;
  password: string | undefined;
}

type Validation = { ok: true; value: CreateRequest } | { ok: false; message: string };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function validateCreate(body: Record<string, unknown>): Validation {
  if (!Object.keys(body).every((key) => ALLOWED_FIELDS.includes(key))) {
    return { ok: false, message: 'Unexpected fields in the request' };
  }

  const { name, scope, expiryDays, password } = body;
  if (typeof name !== 'string' || name.trim().length === 0) return { ok: false, message: 'name is required' };
  const trimmed = name.trim();
  if (trimmed.length > MAX_TOKEN_NAME_LENGTH) {
    return { ok: false, message: `name must be at most ${MAX_TOKEN_NAME_LENGTH} characters` };
  }
  if (CONTROL_CHARACTERS.test(name)) return { ok: false, message: 'name must not contain control characters' };
  if (scope !== 'read' && scope !== 'write') return { ok: false, message: "scope must be 'read' or 'write'" };
  if (expiryDays !== null && !(typeof expiryDays === 'number' && EXPIRY_DAYS.includes(expiryDays))) {
    return { ok: false, message: 'expiryDays must be 90, 180, 365, 730 or null' };
  }
  if (password !== undefined && (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH)) {
    return { ok: false, message: `password must be a string of at most ${MAX_PASSWORD_LENGTH} characters` };
  }

  return { ok: true, value: { name: trimmed, scope, expiryDays, password } };
}

async function create(event: APIGatewayProxyEventV2, userId: string): Promise<ApiResponse> {
  const body = parseJsonObject(event);
  if (!body) return err(400, 'Invalid JSON');
  const validation = validateCreate(body);
  if (validation.ok === false) return err(400, validation.message);
  const { name, scope, expiryDays, password } = validation.value;

  const store = getStore();
  if (needsPassword(scope)) {
    const refusal = await checkPassword(store, password);
    if (refusal) return refusal;
  }

  try {
    const { token, record } = await createToken(store, { userId, name, scope, expiryDays }, nowSeconds());
    console.log('Access token created:', record.tokenId, record.scope);
    return { statusCode: 201, headers: SECURITY_HEADERS, body: JSON.stringify({ token, record }) };
  } catch (error) {
    if (error instanceof TokenLimitError) return err(409, 'You can have at most 25 access tokens. Revoke one first.');
    throw error;
  }
}

export async function createAccessToken(
  event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  return noStore(await create(event, userId));
}

export async function listAccessTokens(
  _event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  return noStore(ok({ tokens: await listTokens(getStore(), userId) }));
}

export async function revokeAccessToken(
  _event: APIGatewayProxyEventV2,
  userId: string,
  params: Record<string, string>,
): Promise<ApiResponse> {
  const { tokenId } = params;
  if (!UUID_PATTERN.test(tokenId) || !(await revokeToken(getStore(), userId, tokenId))) {
    return noStore(err(404, 'Token not found'));
  }
  console.log('Access token revoked:', tokenId);
  return noStore({ statusCode: 204, headers: SECURITY_HEADERS, body: '' });
}
