import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import Ajv2020 from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../../api-handler';
import { setAuth } from '../../auth';
import type { AuthResult } from '../../auth';
import { createToken } from '../../auth/tokens';
import type { TokenScope } from '../../auth/tokens';
import { setStore } from '../../store';
import type { Store } from '../../store';
import { MemoryStore } from '../../store/memory';
import type { ApiResponse } from '../types';
import { err } from '../http';
import { loadSpec, operations } from './openapiSpec';
import type { OpenApiDocument, SpecOperation } from './openapiSpec';

// Calls every operation of docs/openapi.yaml through the real handler with the spec's own examples and checks the
// answers against the spec's schemas. The spec states that its examples assume the clock is in October 2026.
const CLOCK = '2026-10-30T12:00:00Z';
const USER = 'contract-user';
const TOKEN_USER = 'token-user';
const SOURCE_IP = '203.0.113.1';
const BLOCKED_IP = '203.0.113.99';
const UUID = '6f1d2c8e-3b4a-4c5d-8e9f-0a1b2c3d4e5f';
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const OAUTH_CLIENT_ID = 'EXAMPLE_CLIENT_ID';
const OAUTH_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

type Json = any;

interface RequestSpec {
  path?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: Json;
}

const spec: OpenApiDocument = loadSpec();
const ops: SpecOperation[] = operations(spec);
const keyOf = (op: { method: string; template: string }): string => `${op.method} ${op.template}`;
const opByKey = (key: string): SpecOperation => {
  const op = ops.find((candidate) => keyOf(candidate) === key);
  if (!op) throw new Error(`no operation ${key} in docs/openapi.yaml`);
  return op;
};

// ---- Schema validation -------------------------------------------------------------------------------------------

function deref(node: Json): Json {
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.$ref !== 'string') return node;
  const target = node.$ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((current: Json, part: string) => current?.[part], spec);
  if (target === undefined) throw new Error(`unresolved $ref ${node.$ref}`);
  return deref(target);
}

// Inlines every $ref and drops the documentation-only keywords (`example` and `x-*`), so Ajv runs in strict mode.
function toJsonSchema(node: Json, trail: string[] = []): Json {
  if (Array.isArray(node)) return node.map((item) => toJsonSchema(item, trail));
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    if (trail.includes(node.$ref)) throw new Error(`recursive $ref ${node.$ref}`);
    return toJsonSchema(deref(node), [...trail, node.$ref]);
  }
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== 'example' && !key.startsWith('x-'))
      .map(([key, value]) => [key, key === 'properties' || key === '$defs' ? mapValues(value, trail) : toJsonSchema(value, trail)]),
  );
}

function mapValues(record: Json, trail: string[]): Json {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, toJsonSchema(value, trail)]));
}

const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);

const validators = new Map<string, ValidateFunction>();
function validatorFor(schema: Json): ValidateFunction {
  const inlined = toJsonSchema(schema);
  const cacheKey = JSON.stringify(inlined);
  let validate = validators.get(cacheKey);
  if (!validate) {
    validate = ajv.compile(inlined);
    validators.set(cacheKey, validate);
  }
  return validate;
}

function schemaProblems(schema: Json, value: unknown): string[] {
  const validate = validatorFor(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`);
}

// ---- Reading the spec --------------------------------------------------------------------------------------------

function parametersOf(op: SpecOperation): Json[] {
  const item = spec.paths[op.template];
  return [...(item.parameters ?? []), ...((op.operation.parameters as Json[]) ?? [])].map(deref);
}

function parameterExample(parameter: Json): unknown {
  if (parameter.example !== undefined) return parameter.example;
  return parameter.schema?.examples?.[0];
}

function requestContent(op: SpecOperation): Json {
  const requestBody = deref((op.operation as Json).requestBody);
  return requestBody?.content?.['application/json'];
}

function requestExamples(op: SpecOperation): Record<string, unknown> {
  const content = requestContent(op);
  if (!content) return {};
  if (content.examples) {
    return Object.fromEntries(Object.entries(content.examples).map(([name, example]) => [name, (example as Json).value]));
  }
  return content.example === undefined ? {} : { example: content.example };
}

function responseOf(op: SpecOperation, status: string): Json {
  const response = (op.operation as Json).responses[status];
  return response === undefined ? undefined : deref(response);
}

function documentedStatuses(op: SpecOperation): string[] {
  return Object.keys((op.operation as Json).responses);
}

function untestedStatuses(op: SpecOperation): Record<string, string> {
  return ((op.operation as Json)['x-untested'] as Record<string, string> | undefined) ?? {};
}

// ---- Driving the real handler -----------------------------------------------------------------------------------

let store: MemoryStore;
let authenticate: ReturnType<typeof vi.fn<(event: APIGatewayProxyEventV2) => Promise<AuthResult>>>;

const exercised = new Set<string>();

function makeEvent(
  op: { method: string; template: string },
  request: RequestSpec,
  extra: { authorization?: string; sourceIp?: string } = {},
): APIGatewayProxyEventV2 {
  let rawPath = op.template;
  for (const [name, value] of Object.entries(request.path ?? {})) rawPath = rawPath.replace(`{${name}}`, encodeURIComponent(value));
  const body = request.body === undefined ? undefined : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  return {
    rawPath,
    headers: extra.authorization === undefined ? {} : { authorization: extra.authorization },
    body,
    queryStringParameters: request.query,
    requestContext: { routeKey: keyOf(op), http: { method: op.method, sourceIp: extra.sourceIp ?? SOURCE_IP } },
  } as unknown as APIGatewayProxyEventV2;
}

async function send(
  op: { method: string; template: string },
  request: RequestSpec = {},
  extra: { authorization?: string; sourceIp?: string } = {},
): Promise<Reply> {
  const response = (await handler(makeEvent(op, request, extra), {} as Context, () => {})) as ApiResponse;
  const text = response.body ?? '';
  let json: Json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.statusCode, headers: (response.headers ?? {}) as Record<string, string>, text, json };
}

// A request built only from the spec's examples. Path parameters without an example take `overrides`, then a placeholder.
function requestFromSpec(op: SpecOperation, exampleName: string | undefined, overrides: Record<string, string> = {}): RequestSpec {
  const path: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const parameter of parametersOf(op)) {
    const example = parameterExample(parameter);
    if (parameter.in === 'path') path[parameter.name] = overrides[parameter.name] ?? (example === undefined ? UNKNOWN_UUID : String(example));
    if (parameter.in === 'query' && example !== undefined) query[parameter.name] = String(example);
  }
  const request: RequestSpec = { path };
  if (Object.keys(query).length > 0) request.query = query;
  const examples = requestExamples(op);
  if (exampleName !== undefined) {
    if (!(exampleName in examples)) throw new Error(`${keyOf(op)} has no request example "${exampleName}"`);
    request.body = examples[exampleName];
  }
  return request;
}

// Everything a reply must satisfy whatever the case: a documented status, the documented body and headers.
function replyProblems(op: SpecOperation, reply: Reply): string[] {
  const status = String(reply.status);
  const response = responseOf(op, status);
  if (!response) return [`status ${status} is not documented (documented: ${documentedStatuses(op).join(', ')}); body ${reply.text}`];
  const problems: string[] = [];
  const content = response.content?.['application/json'];
  const markdown = response.content?.['text/markdown'];
  if (markdown) {
    if (reply.text === '') problems.push(`${status} should have a Markdown body but returned none`);
    if (!reply.headers['Content-Type']?.startsWith('text/markdown')) problems.push(`${status} should be text/markdown`);
  } else if (!content) {
    if (reply.text !== '') problems.push(`${status} is documented without a body but returned ${reply.text}`);
  } else if (reply.json === undefined) {
    problems.push(`${status} should have a JSON body but returned ${JSON.stringify(reply.text)}`);
  } else {
    problems.push(...schemaProblems(content.schema, reply.json).map((problem) => `${status} body ${problem}`));
  }
  for (const [name, header] of Object.entries<Json>(response.headers ?? {})) {
    const value = reply.headers[name];
    if (value === undefined) problems.push(`${status} should send the ${name} header`);
    else problems.push(...schemaProblems(header.schema, header.schema.type === 'integer' ? Number(value) : value).map((p) => `${name} header ${p}`));
  }
  return problems;
}

async function exchange(op: SpecOperation, request: RequestSpec, label: string): Promise<Reply> {
  const reply = await send(op, request);
  expect(replyProblems(op, reply), `${label}: ${keyOf(op)} answered ${reply.status}`).toEqual([]);
  exercised.add(`${keyOf(op)} ${reply.status}`);
  return reply;
}

// ---- The walkthrough ---------------------------------------------------------------------------------------------

type Context_ = Record<string, string>;

interface Step {
  key: string;
  example?: string;
  path?: (ctx: Context_) => Record<string, string>;
  capture?: (body: Json, ctx: Context_) => void;
}

// Each operation, in an order that keeps the household valid: create before update, delete last. A step names the
// request example it sends; ids returned by a create replace the spec's placeholders in later paths.
const STEPS: Step[] = [
  { key: 'GET /api/categories' },
  { key: 'POST /api/categories', example: 'expense', capture: (body, ctx) => { ctx.customCategory = body.category.categoryId; } },
  { key: 'POST /api/categories', example: 'pot' },
  { key: 'PUT /api/categories/{categoryId}', example: 'example', path: (ctx) => ({ categoryId: ctx.customCategory }) },
  { key: 'GET /api/targets' },
  { key: 'PUT /api/targets/{categoryId}', example: 'example', path: () => ({ categoryId: 'cat-groceries' }) },
  { key: 'GET /api/targets' },
  { key: 'GET /api/expected-income' },
  { key: 'PUT /api/expected-income', example: 'example' },
  { key: 'GET /api/expected-income' },
  { key: 'POST /api/transactions', example: 'expense' },
  { key: 'POST /api/transactions', example: 'income' },
  { key: 'GET /api/transactions' },
  { key: 'GET /api/transactions/range' },
  { key: 'PUT /api/transactions/{yearMonth}/{transactionId}', example: 'example' },
  { key: 'PUT /api/pots/{categoryId}', example: 'autoOn' },
  { key: 'PUT /api/pots/{categoryId}', example: 'noAuto' },
  { key: 'GET /api/pots' },
  { key: 'POST /api/pots/{categoryId}/archive', example: 'example' },
  { key: 'POST /api/pots/{categoryId}/unarchive' },
  { key: 'POST /api/recurring', example: 'monthly', capture: (body, ctx) => { ctx.monthlyId = body.recurring.recurringId; } },
  { key: 'POST /api/recurring', example: 'weekly', capture: (body, ctx) => { ctx.weeklyId = body.recurring.recurringId; } },
  { key: 'GET /api/recurring' },
  { key: 'PUT /api/recurring/{recurringId}', example: 'example', path: (ctx) => ({ recurringId: ctx.monthlyId }) },
  { key: 'POST /api/recurring/{recurringId}/handled', example: 'month', path: (ctx) => ({ recurringId: ctx.monthlyId }) },
  { key: 'POST /api/recurring/{recurringId}/handled', example: 'occurrence', path: (ctx) => ({ recurringId: ctx.weeklyId }) },
  { key: 'POST /api/recurring/{recurringId}/handled', example: 'clear', path: (ctx) => ({ recurringId: ctx.monthlyId }) },
  { key: 'DELETE /api/transactions/{yearMonth}/{transactionId}' },
  { key: 'GET /api/trash' },
  { key: 'POST /api/trash/restore', example: 'example' },
  { key: 'POST /api/accounts', example: 'asset', capture: (body, ctx) => { ctx.assetId = body.account.accountId; } },
  { key: 'POST /api/accounts', example: 'liability', capture: (body, ctx) => { ctx.liabilityId = body.account.accountId; } },
  { key: 'GET /api/accounts' },
  { key: 'PUT /api/accounts/{accountId}', example: 'example', path: (ctx) => ({ accountId: ctx.assetId }) },
  { key: 'POST /api/accounts/{accountId}/balances', example: 'example', path: (ctx) => ({ accountId: ctx.assetId }) },
  { key: 'POST /api/push/subscriptions', example: 'example' },
  { key: 'DELETE /api/push/subscriptions', example: 'example' },
  { key: 'GET /api/openapi.json' },
  { key: 'GET /api/docs/agents' },
  { key: 'POST /api/tokens', example: 'read', capture: (body, ctx) => { ctx.tokenId = body.record.tokenId; } },
  { key: 'POST /api/tokens', example: 'write' },
  { key: 'GET /api/tokens' },
  { key: 'DELETE /api/tokens/{tokenId}', path: (ctx) => ({ tokenId: ctx.tokenId }) },
  { key: 'GET /api/oauth/client' },
  { key: 'POST /api/oauth/authorize', example: 'read' },
  { key: 'POST /api/categories/{categoryId}/reassign', example: 'example', path: (ctx) => ({ categoryId: ctx.customCategory }) },
  { key: 'DELETE /api/categories/{categoryId}', path: (ctx) => ({ categoryId: ctx.customCategory }) },
  { key: 'DELETE /api/targets/{categoryId}', path: () => ({ categoryId: 'cat-groceries' }) },
  { key: 'DELETE /api/expected-income' },
  { key: 'DELETE /api/recurring/{recurringId}', path: (ctx) => ({ recurringId: ctx.monthlyId }) },
  { key: 'DELETE /api/accounts/{accountId}', path: (ctx) => ({ accountId: ctx.liabilityId }) },
];

// ---- Error cases -------------------------------------------------------------------------------------------------

// A case provokes one documented non-2xx status on a fresh store. `run` may arrange state first and returns the request
// that must be answered with the status in `key`.
interface ErrorCase {
  key: string;
  run: (arrange: Arrange) => Promise<RequestSpec>;
}

interface Arrange {
  call(key: string, exampleName: string | undefined, overrides?: Record<string, string>): Promise<Json>;
  callWith(key: string, request: RequestSpec): Promise<Json>;
}

const POT = 'cat-holidays';
const PUSH_BODY = (endpoint: string): Json => ({
  subscription: { endpoint, expirationTime: null, keys: { p256dh: 'EXAMPLE_p256dh_key_not_real', auth: 'EXAMPLE_auth_secret' } },
  settings: { hour: 8, quietStart: 22, quietEnd: 7, timeZone: 'Europe/London' },
});

const ERROR_CASES: ErrorCase[] = [
  { key: 'POST /api/categories 400', run: async () => ({ body: { name: '', type: 'EXPENSE' } }) },
  {
    key: 'PUT /api/categories/{categoryId} 400',
    run: async (arrange) => {
      const created = await arrange.call('POST /api/categories', 'expense');
      return { path: { categoryId: created.category.categoryId }, body: {} };
    },
  },
  { key: 'PUT /api/categories/{categoryId} 403', run: async () => ({ path: { categoryId: 'cat-groceries' }, body: { name: 'Food' } }) },
  { key: 'PUT /api/categories/{categoryId} 404', run: async () => ({ path: { categoryId: UNKNOWN_UUID }, body: { name: 'Food' } }) },
  { key: 'DELETE /api/categories/{categoryId} 403', run: async () => ({ path: { categoryId: 'cat-groceries' } }) },
  { key: 'POST /api/categories/{categoryId}/reassign 400', run: async () => ({ path: { categoryId: 'cat-groceries' }, body: {} }) },
  { key: 'PUT /api/targets/{categoryId} 400', run: async () => ({ path: { categoryId: 'cat-groceries' }, body: { targetAmount: 0, period: 'MONTHLY' } }) },
  { key: 'PUT /api/targets/{categoryId} 404', run: async () => ({ path: { categoryId: UNKNOWN_UUID }, body: { targetAmount: 30000, period: 'MONTHLY' } }) },
  { key: 'PUT /api/expected-income 400', run: async () => ({ body: { amount: 0 } }) },
  { key: 'GET /api/transactions 400', run: async () => ({}) },
  { key: 'POST /api/transactions 400', run: async () => ({ body: {} }) },
  { key: 'GET /api/transactions/range 400', run: async () => ({ query: { from: '2026-10', to: '2026-08' } }) },
  { key: 'PUT /api/transactions/{yearMonth}/{transactionId} 400', run: async () => ({ path: { yearMonth: '2026-10', transactionId: UUID }, body: {} }) },
  {
    key: 'PUT /api/transactions/{yearMonth}/{transactionId} 404',
    run: async () => ({
      path: { yearMonth: '2026-10', transactionId: UNKNOWN_UUID },
      body: { amount: 1400, type: 'EXPENSE', categoryId: 'cat-groceries', date: '2026-10-29' },
    }),
  },
  { key: 'DELETE /api/transactions/{yearMonth}/{transactionId} 400', run: async () => ({ path: { yearMonth: '2026-13', transactionId: UUID } }) },
  { key: 'GET /api/pots 400', run: async () => ({ query: { asOf: '2030-01' } }) },
  {
    key: 'PUT /api/pots/{categoryId} 400',
    run: async () => ({ path: { categoryId: POT }, body: { monthlyAmount: null, goalAmount: null, autoContribute: true, month: '2026-10' } }),
  },
  {
    key: 'PUT /api/pots/{categoryId} 409',
    run: async (arrange) => {
      await arrange.callWith('POST /api/pots/{categoryId}/archive', { path: { categoryId: POT }, body: { month: '2026-10' } });
      return { path: { categoryId: POT }, body: { monthlyAmount: 5000, goalAmount: null, autoContribute: false, month: '2026-10' } };
    },
  },
  { key: 'POST /api/pots/{categoryId}/archive 400', run: async () => ({ path: { categoryId: POT }, body: { month: 'soon' } }) },
  {
    key: 'POST /api/pots/{categoryId}/archive 409',
    run: async (arrange) => {
      await arrange.callWith('POST /api/transactions', {
        body: { amount: 2000, type: 'SET_ASIDE', categoryId: POT, description: '', date: '2026-10-29' },
      });
      return { path: { categoryId: POT }, body: { month: '2026-10' } };
    },
  },
  { key: 'POST /api/pots/{categoryId}/unarchive 409', run: async () => ({ path: { categoryId: POT } }) },
  { key: 'POST /api/pots/{categoryId}/unarchive 400', run: async () => ({ path: { categoryId: 'cat-groceries' } }) },
  { key: 'POST /api/recurring 400', run: async () => ({ body: { type: 'EXPENSE', categoryId: 'cat-mortgage', amount: 90000, frequency: 'MONTHLY', dayOfMonth: 40 } }) },
  {
    key: 'PUT /api/recurring/{recurringId} 400',
    run: async (arrange) => {
      const created = await arrange.call('POST /api/recurring', 'monthly');
      return { path: { recurringId: created.recurring.recurringId }, body: '{not json' };
    },
  },
  {
    key: 'PUT /api/recurring/{recurringId} 404',
    run: async () => ({
      path: { recurringId: UNKNOWN_UUID },
      body: { type: 'EXPENSE', categoryId: 'cat-mortgage', amount: 95000, frequency: 'MONTHLY', dayOfMonth: 1 },
    }),
  },
  {
    key: 'POST /api/recurring/{recurringId}/handled 400',
    run: async (arrange) => {
      const created = await arrange.call('POST /api/recurring', 'monthly');
      return { path: { recurringId: created.recurring.recurringId }, body: { period: '2026-10-15' } };
    },
  },
  { key: 'POST /api/recurring/{recurringId}/handled 404', run: async () => ({ path: { recurringId: UNKNOWN_UUID }, body: { period: 'soon' } }) },
  { key: 'POST /api/trash/restore 400', run: async () => ({ body: { entityType: 'TRANSACTION', id: 'x', extra: true } }) },
  { key: 'POST /api/trash/restore 404', run: async () => ({ body: { entityType: 'TRANSACTION', id: `2026-10#${UNKNOWN_UUID}` } }) },
  {
    key: 'POST /api/trash/restore 409',
    run: async (arrange) => {
      await arrange.call('POST /api/transactions', 'expense');
      await arrange.call('DELETE /api/transactions/{yearMonth}/{transactionId}', undefined);
      await arrange.call('POST /api/transactions', 'expense');
      return { body: { entityType: 'TRANSACTION', id: `2026-10#${UUID}` } };
    },
  },
  { key: 'POST /api/accounts 400', run: async () => ({ body: { name: 'Odd', kind: 'LIABILITY', type: 'SAVINGS' } }) },
  {
    key: 'PUT /api/accounts/{accountId} 400',
    run: async (arrange) => {
      const created = await arrange.call('POST /api/accounts', 'asset');
      return { path: { accountId: created.account.accountId }, body: { name: '' } };
    },
  },
  { key: 'PUT /api/accounts/{accountId} 404', run: async () => ({ path: { accountId: UNKNOWN_UUID }, body: { name: 'Savings' } }) },
  {
    key: 'POST /api/accounts/{accountId}/balances 400',
    run: async (arrange) => {
      const created = await arrange.call('POST /api/accounts', 'asset');
      return { path: { accountId: created.account.accountId }, body: { date: '2027-01-01', pence: 100 } };
    },
  },
  // The account is looked up before the body is checked, so an unknown account is a 404 even with an invalid body.
  { key: 'POST /api/accounts/{accountId}/balances 404', run: async () => ({ path: { accountId: UNKNOWN_UUID }, body: { date: '2027-01-01', pence: 1.5 } }) },
  { key: 'POST /api/push/subscriptions 400', run: async () => ({ body: { ...PUSH_BODY('https://fcm.googleapis.com/fcm/send/a'), settings: { hour: 24, quietStart: 22, quietEnd: 7, timeZone: 'Europe/London' } } }) },
  {
    key: 'POST /api/push/subscriptions 409',
    run: async (arrange) => {
      for (let i = 1; i <= 5; i++) await arrange.callWith('POST /api/push/subscriptions', { body: PUSH_BODY(`https://fcm.googleapis.com/fcm/send/device-${i}`) });
      return { body: PUSH_BODY('https://fcm.googleapis.com/fcm/send/device-6') };
    },
  },
  { key: 'DELETE /api/push/subscriptions 400', run: async () => ({ body: { endpoint: 'http://example.com' } }) },
  { key: 'POST /api/tokens 400', run: async () => ({ body: { name: 'Script', scope: 'read', expiryDays: 7 } }) },
  {
    key: 'POST /api/tokens 409',
    run: async (arrange) => {
      for (let i = 1; i <= 25; i++) await arrange.callWith('POST /api/tokens', { body: { name: `Script ${i}`, scope: 'read', expiryDays: 90 } });
      return { body: { name: 'One too many', scope: 'read', expiryDays: 90 } };
    },
  },
  { key: 'GET /api/oauth/client 404', run: async () => ({ query: { client_id: 'unknown', redirect_uri: OAUTH_REDIRECT } }) },
  { key: 'POST /api/oauth/authorize 400', run: async () => ({ body: { client_id: OAUTH_CLIENT_ID, redirect_uri: OAUTH_REDIRECT, scope: 'admin', code_challenge: 'x' } }) },
  { key: 'POST /api/oauth/authorize 404', run: async () => ({ body: { client_id: 'unknown', redirect_uri: OAUTH_REDIRECT, scope: 'read', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' } }) },
  { key: 'DELETE /api/tokens/{tokenId} 404', run: async () => ({ path: { tokenId: UNKNOWN_UUID } }) },
];

// ---- Setup -------------------------------------------------------------------------------------------------------

function freshStore(): MemoryStore {
  store = new MemoryStore();
  setStore(store);
  return store;
}

// The OAuth examples name this client, so the consent routes have one to find.
async function seedOauthClient(target: Store): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await target.put({
    PK: 'OAUTH#CLIENTS', SK: OAUTH_CLIENT_ID, name: 'Claude', redirectUris: [OAUTH_REDIRECT], createdAt: now, expiresAt: now + 86400,
  });
}

let savedOrigin: string | undefined;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CLOCK));
  savedOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://hoard.example';
  await seedOauthClient(freshStore());
  authenticate = vi.fn<(event: APIGatewayProxyEventV2) => Promise<AuthResult>>().mockResolvedValue({ userId: USER });
  setAuth({ mode: 'auth0', authenticate, handlePublic: async () => undefined });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = savedOrigin;
  setAuth(undefined);
  setStore(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function tokenFor(scope: TokenScope): Promise<string> {
  const { token } = await createToken(store, { userId: TOKEN_USER, name: 'contract', scope, expiryDays: 90 }, Math.floor(Date.now() / 1000));
  return token;
}

// ---- Tests -------------------------------------------------------------------------------------------------------

describe('docs/openapi.yaml contract: the spec\'s own examples', () => {
  it('validate against the schemas of the request and responses they belong to', () => {
    const problems: string[] = [];
    for (const op of ops) {
      const content = requestContent(op);
      if (content) {
        for (const [name, value] of Object.entries(requestExamples(op))) {
          problems.push(...schemaProblems(content.schema, value).map((p) => `${keyOf(op)} request example ${name}: ${p}`));
        }
      }
      for (const status of documentedStatuses(op)) {
        const json = responseOf(op, status).content?.['application/json'];
        if (!json) continue;
        const examples: Record<string, unknown> = json.examples
          ? Object.fromEntries(Object.entries<Json>(json.examples).map(([name, example]) => [name, example.value]))
          : json.example === undefined ? {} : { example: json.example };
        for (const [name, value] of Object.entries(examples)) {
          problems.push(...schemaProblems(json.schema, value).map((p) => `${keyOf(op)} ${status} example ${name}: ${p}`));
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('docs/openapi.yaml contract: the real handlers', () => {
  it('names a step for every operation and request example, and only for ones the spec has', () => {
    const stepKeys = new Set(STEPS.map((step) => step.key));
    expect(STEPS.filter((step) => !ops.some((op) => keyOf(op) === step.key)).map((step) => step.key)).toEqual([]);
    expect(ops.filter((op) => !stepKeys.has(keyOf(op))).map(keyOf)).toEqual([]);
    const missing = ops.flatMap((op) =>
      Object.keys(requestExamples(op))
        .filter((name) => !STEPS.some((step) => step.key === keyOf(op) && step.example === name))
        .map((name) => `${keyOf(op)} example ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it('answers every operation with the status, body and headers the spec documents, using its examples', async () => {
    const ctx: Context_ = {};
    for (const [index, step] of STEPS.entries()) {
      const op = opByKey(step.key);
      const label = `step ${index + 1} (${step.key}${step.example ? ` ${step.example}` : ''})`;
      const reply = await exchange(op, requestFromSpec(op, step.example, step.path?.(ctx)), label);
      expect(reply.status, `${label} should succeed, body ${reply.text}`).toBeLessThan(300);
      step.capture?.(reply.json, ctx);
    }
  });

  describe('documented errors', () => {
    it.each(ERROR_CASES.map((errorCase) => [errorCase.key, errorCase] as const))('%s', async (_key, errorCase) => {
      const separator = errorCase.key.lastIndexOf(' ');
      const opKey = errorCase.key.slice(0, separator);
      const status = Number(errorCase.key.slice(separator + 1));
      const op = opByKey(opKey);
      const arrange: Arrange = {
        call: async (key, exampleName, overrides) => (await send(opByKey(key), requestFromSpec(opByKey(key), exampleName, overrides))).json,
        callWith: async (key, request) => (await send(opByKey(key), request)).json,
      };
      const request = await errorCase.run(arrange);
      const reply = await exchange(op, request, errorCase.key);
      expect(reply.status, `${errorCase.key} body ${reply.text}`).toBe(status);
    });

    it('answers 401 for every operation when the credential is refused', async () => {
      authenticate.mockResolvedValue({ rejection: err(401, 'Unauthorized') });
      for (const op of ops) {
        const reply = await exchange(op, requestFromSpec(op, Object.keys(requestExamples(op))[0]), '401');
        expect(reply.status, keyOf(op)).toBe(401);
      }
    });

    it('answers 403 to an access token that may not use an operation', async () => {
      const read = await tokenFor('read');
      const write = await tokenFor('write');
      for (const op of ops) {
        const access = (op.operation as Json)['x-token-access'];
        if (access === 'read') continue;
        const request = requestFromSpec(op, Object.keys(requestExamples(op))[0]);
        const authorization = `Bearer ${access === 'write' ? read : write}`;
        const reply = await send(op, request, { authorization });
        expect(replyProblems(op, reply), keyOf(op)).toEqual([]);
        expect(reply.status, keyOf(op)).toBe(403);
        exercised.add(`${keyOf(op)} 403`);
      }
    });

    it('answers 429 with Retry-After to an address that has failed too many token lookups', async () => {
      const unknown = `Bearer hwr_${'A'.repeat(43)}`;
      const first = ops[0];
      for (let i = 0; i < 31; i++) await send(first, {}, { authorization: unknown, sourceIp: BLOCKED_IP });
      for (const op of ops) {
        const request = requestFromSpec(op, Object.keys(requestExamples(op))[0]);
        const reply = await send(op, request, { authorization: unknown, sourceIp: BLOCKED_IP });
        expect(replyProblems(op, reply), keyOf(op)).toEqual([]);
        expect(reply.status, keyOf(op)).toBe(429);
        exercised.add(`${keyOf(op)} 429`);
      }
    });

    it('answers a generic 500 for every operation when the store fails', async () => {
      const failing = new Proxy(store, {
        get: (target, property) => (typeof (target as any)[property] === 'function' ? async () => { throw new Error('store down'); } : (target as any)[property]),
      }) as Store;
      setStore(failing);
      // The docs routes read no store, so they have no 500 to document; every other route must.
      const docsOps = ops.filter((candidate) => (candidate.operation as Json).tags?.includes('docs'));
      expect(docsOps.length).toBeGreaterThan(0);
      for (const op of ops.filter((candidate) => !docsOps.includes(candidate))) {
        expect(responseOf(op, '500'), keyOf(op)).toBeDefined();
      }
      for (const op of ops.filter((candidate) => !docsOps.includes(candidate))) {
        const request = requestFromSpec(op, Object.keys(requestExamples(op))[0]);
        const reply = await send(op, request);
        expect(replyProblems(op, reply), keyOf(op)).toEqual([]);
        expect(reply.status, keyOf(op)).toBe(500);
        expect(reply.json, keyOf(op)).toEqual({ error: 'Internal server error' });
        exercised.add(`${keyOf(op)} 500`);
      }
    });

    it('answers 400 for every operation with a request body when the body is not a JSON object', async () => {
      const withBody = ops.filter((op) => requestContent(op) !== undefined);
      expect(withBody.length).toBeGreaterThan(0);
      // Records that exist, so a 400 can only come from the body check and not from a 404.
      const category = (await send(opByKey('POST /api/categories'), requestFromSpec(opByKey('POST /api/categories'), 'expense'))).json;
      const account = (await send(opByKey('POST /api/accounts'), requestFromSpec(opByKey('POST /api/accounts'), 'asset'))).json;
      const transaction = (await send(opByKey('POST /api/transactions'), requestFromSpec(opByKey('POST /api/transactions'), 'expense'))).json;
      const recurring = (await send(opByKey('POST /api/recurring'), requestFromSpec(opByKey('POST /api/recurring'), 'monthly'))).json;
      const existing: Record<string, string> = {
        categoryId: category.category.categoryId,
        accountId: account.account.accountId,
        yearMonth: transaction.transaction.yearMonth,
        transactionId: transaction.transaction.transactionId,
        recurringId: recurring.recurring.recurringId,
      };
      for (const op of withBody) {
        const base = requestFromSpec(op, undefined, existing);
        for (const body of ['null', '[]', '"text"', '123', 'true', '{']) {
          const reply = await send(op, { ...base, body });
          expect(replyProblems(op, reply), `${keyOf(op)} body ${body}`).toEqual([]);
          expect(reply.status, `${keyOf(op)} body ${body}: ${reply.text}`).toBe(400);
          exercised.add(`${keyOf(op)} 400`);
        }
      }
    });

    it('answers HEAD to every GET operation with the status of GET and an empty body', async () => {
      const reads = ops.filter((op) => op.method === 'GET');
      expect(reads.length).toBeGreaterThan(0);
      for (const op of reads) {
        const request = requestFromSpec(op, undefined);
        const get = await send(op, request);
        const head = await send({ ...op, method: 'HEAD' }, request);
        expect(head.status, `HEAD ${op.template}`).toBe(get.status);
        expect(head.text, `HEAD ${op.template}`).toBe('');
      }
    });

    it('lists no case, and no x-untested marker, for a status the spec does not document', () => {
      const unknown = ERROR_CASES.map((c) => c.key).filter((key) => {
        const separator = key.lastIndexOf(' ');
        const op = ops.find((candidate) => keyOf(candidate) === key.slice(0, separator));
        return !op || !documentedStatuses(op).includes(key.slice(separator + 1));
      });
      expect(unknown).toEqual([]);
      const badMarkers = ops.flatMap((op) =>
        Object.entries(untestedStatuses(op))
          .filter(([status, reason]) => !documentedStatuses(op).includes(status) || typeof reason !== 'string' || reason.trim() === '')
          .map(([status]) => `${keyOf(op)} ${status}`),
      );
      expect(badMarkers).toEqual([]);
    });

    it('exercises every documented non-2xx status or marks it x-untested', () => {
      const uncovered = ops.flatMap((op) =>
        documentedStatuses(op)
          .filter((status) => !status.startsWith('2'))
          .filter((status) => !exercised.has(`${keyOf(op)} ${status}`) && untestedStatuses(op)[status] === undefined)
          .map((status) => `${keyOf(op)} ${status}`),
      );
      expect(uncovered).toEqual([]);
      const staleMarkers = ops.flatMap((op) =>
        Object.keys(untestedStatuses(op))
          .filter((status) => exercised.has(`${keyOf(op)} ${status}`))
          .map((status) => `${keyOf(op)} ${status}`),
      );
      expect(staleMarkers).toEqual([]);
    });
  });
});
