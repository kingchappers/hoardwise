# Swap the hand-written MCP protocol layer for the official SDK (plan 1b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `/mcp` with `@modelcontextprotocol/server` (v2) instead of the hand-written JSON-RPC layer from plan 1, without changing what the tools return or who can call them.

**Architecture:** `src/mcp/handler.ts` keeps every check that happens before the protocol (method, `Origin`, IP block, token auth, per-user limit, base64 decode) and then converts the event to a Web `Request` and calls `createMcpHandler(factory, { responseMode: 'json', legacy: 'stateless', maxRequestBodySize: 65_536 }).fetch(request, { authInfo })`. The factory builds a fresh `McpServer` per request and registers only the tools the token's scope allows. `src/mcp/protocol.ts` is deleted. The tools (`src/mcp/tools/*`), `review.ts`, `calc.ts`, `data.ts` and their tests stay.

**Tech Stack:** `@modelcontextprotocol/server` pinned to an exact version (2.4.0 at time of writing), `zod` (a dependency of the SDK), TypeScript 5.9, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-31-mcp-design.md`, section "The official MCP SDK". Plan 1 is `docs/superpowers/plans/2026-10-31-mcp-endpoint.md` (built on this branch, PR #122).

## Global Constraints

All of plan 1's Global Constraints still hold (token-only access, `Origin` 403, 64 KiB body cap with 413, 200,000-character result cap, 60 requests per minute per user, no logging of bodies, arguments or tokens, free text only in `text`/`name`/`label` fields with the privacy note, every result with money carries `unit: 'pence'`). Additionally:

- The SDK dependency is pinned to an exact version (no `^`), is MIT-licensed, and its full dependency tree is listed in the PR description.
- Supported client protocol versions are whatever the SDK supports. `2025-06-18` clients must keep working, through the SDK's stateless legacy path.
- Every successful call gets one complete JSON reply (no streaming); `GET` and `DELETE` on `/mcp` answer 405.
- The SDK never reads credentials: authentication stays in `api-handler.ts`/`src/mcp/handler.ts`, which pass `authInfo` in.
- Nothing from the SDK is imported by the browser demo bundle.
- Reference control IDs in commits. Conventional commits, imperative, under 72 characters. Trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_0164Feb96AP7ZVnA8tMDaooj`.

## Review Focus

1. **Scope is still enforced** (Task 2): a read token cannot list or call any tool it could not before; an unknown or unregistered tool is an error, not a silent success.
2. **No leak through errors** (Task 2, Task 3): a throwing tool, an unserialisable result, malformed JSON and an SDK-level error never put a message, stack, argument or description in the reply or in a log line.
3. **The build still works** (Task 1): `tsc --module commonjs` in the Lambda and container builds resolves and loads the SDK at runtime from `build/api` and from the container image.
4. **Limits survive the swap** (Task 2): the 64 KiB cap, the 200,000-character result cap and the `Origin` refusal are still enforced, in the same order, with the same status codes.
5. **Response shape** (Task 2, Task 3): every reply is `application/json` and complete (no SSE) behind API Gateway's HTTP API and in the container.

---

### Task 1: Add the dependency and prove the build chain (gate)

**Files:**
- Modify: `package.json`, `yarn.lock`, `scripts/build-api-handler.cjs` (the Lambda dependency list), and whatever installs runtime dependencies for the container (read `scripts/build-container.cjs`, `Dockerfile` and `container/` first: the container build does not appear to install node_modules at runtime, so find out how the API handler's dependencies reach the image today and add the SDK the same way)
- Test: `src/mcp/__tests__/sdkImport.test.ts`

**Interfaces:** Produces a working import of `createMcpHandler` and `McpServer` from `@modelcontextprotocol/server` in all four places: Vitest, `yarn typecheck` (moduleResolution `bundler`), the Lambda build (`tsc ... --module commonjs`), and the container build.

- [ ] **Step 1: Write a failing test:** `sdkImport.test.ts` builds a handler with `createMcpHandler(() => new McpServer({ name: 'hoardwise', version: '0.0.0' }), { responseMode: 'json' })`, sends a Web `Request` for a JSON-RPC `initialize` with `application/json` and an `Accept: application/json, text/event-stream` header, and expects a 200 `application/json` reply whose result has a `serverInfo.name` of `hoardwise`.
- [ ] **Step 2: Run it:** `yarn vitest run src/mcp/__tests__/sdkImport.test.ts`. Expected: FAIL (package not installed).
- [ ] **Step 3: Add the dependency** with `yarn add @modelcontextprotocol/server@2.4.0 --exact` (and `zod` if the SDK needs it as a peer). Add both to the Lambda dependency list in `scripts/build-api-handler.cjs`. Then make these pass, changing build flags only as far as needed and writing down what you changed and why: `yarn typecheck`; `yarn build` (dummy `VITE_AUTH0_*` values in the environment only); `yarn build:container`; and a Node `require` smoke of the built output: run `node -e "require('./build/api/index.js')"` from the repo root and the equivalent for `build/container/container/bin.js` without starting a server (use `--check` or an env guard if importing starts one; read the files). The Lambda and container builds compile with `--module commonjs` and default module resolution, which cannot read a package `exports` map: expect `Cannot find module '@modelcontextprotocol/server'` and fix it (for example by adding `--moduleResolution node16 --module node16` consistent with how the compiled output is marked CommonJS, or the smallest change that works). If the only working fix is a bundler or a change that alters other build outputs, STOP and report BLOCKED with what you tried.
- [ ] **Step 4: Record the cost:** the size of `build/api` (including `node_modules`) and of the zipped Lambda before and after (`du -sk`), the SDK's full runtime dependency list (`npm ls --omit=dev --all` in the built folder or the lockfile), and `yarn audit --groups dependencies` output for the new packages. Put these numbers in your report.
- [ ] **Step 5: Run** the new test and `yarn test`. Expected: PASS. **Commit** `chore: add the official MCP SDK (HOA-11)`.

### Task 2: Serve `/mcp` through the SDK

**Files:**
- Modify: `src/mcp/handler.ts`, `src/mcp/types.ts`, `src/mcp/tools.ts`, and each file in `src/mcp/tools/` only as far as the new tool contract needs
- Create: `src/mcp/sdkServer.ts`
- Delete: `src/mcp/protocol.ts`
- Test: update `src/mcp/__tests__/mcpRequests.test.ts`; Task 3 ports the protocol tests

**Interfaces:**
- Consumes: `createMcpHandler`, `McpServer` (Task 1); `McpTool`, `toolAllowed`, `ToolOutcome` (types.ts); `authenticateToken` and the existing pre-protocol checks in `handler.ts`.
- Produces: `export function createMcpEndpoint(tools: McpTool[]): (request: Request, options: { authInfo: AuthInfo }) => Promise<Response>` in `sdkServer.ts` (build the handler once per module load; the factory reads the scope from `ctx.authInfo?.scopes` and registers only allowed tools with `server.registerTool(name, { title, description, inputSchema, annotations }, callback)`; the callback runs `tool.run(args, context)`, never throws, returns `{ content: [{ type: 'text', text }], structuredContent, isError }` exactly as plan 1's protocol layer did, applies the 200,000-character cap, logs only the tool name and error class). `McpTool` gains an `inputShape` (a zod shape, or `inputSchema` as the SDK expects) kept next to the tool; the tools still validate with `isYearMonth` etc. inside `run` so their error messages are unchanged.

- [ ] **Step 1: Write failing tests** in `mcpRequests.test.ts` for the behaviours that must not change, driving the real `handler` with a read token (follow the existing helpers): `tools/list` shows exactly the five read tools and each tool's `annotations`; `tools/call` `month_review` returns `content` and `structuredContent` with the privacy note; a `hww_` token and a `hwr_` token both see the read tools; `GET /mcp` and `DELETE /mcp` give 405 with `Allow: POST`; a body over 65,536 bytes gives 413; an `Origin` header gives 403; a cookie-only request gives 401 without reaching the auth provider; a base64-encoded body works; the 61st request in a minute gives 429.
- [ ] **Step 2: Run** `yarn vitest run src/mcp`. Expected: the new SDK-path tests FAIL.
- [ ] **Step 3: Implement `createMcpEndpoint`** and rewire `handleMcpRequest`: keep the order method (405), Origin (403), IP block, token auth, per-user limit, then decode the body (base64), build a `Request` (`POST`, `Content-Type`/`Accept` headers as received, body as text), call the endpoint with `authInfo` `{ token: '', clientId: <token id>, scopes: [scope], extra: { userId } }` (never the raw token), convert the `Response` back to an `ApiResponse` with `SECURITY_HEADERS` and `Cache-Control: no-store`, and map any thrown error to a generic 500-free `isError`-style reply or a JSON-RPC internal error without detail. Pass `maxRequestBodySize: 65_536` to the SDK as well as keeping our own 413 check. Delete `protocol.ts` and move anything still needed (`MCP_MAX_BODY_BYTES`, `MCP_MAX_RESULT_CHARS`) to `types.ts` or `handler.ts`.
- [ ] **Step 4: Run** `yarn vitest run src/mcp container`. Expected: PASS apart from the old protocol tests that Task 3 ports.
- [ ] **Step 5: Commit** `feat: serve /mcp with the official SDK (HOA-11)`.

### Task 3: Port the protocol tests to the SDK-backed endpoint

**Files:**
- Modify: `src/mcp/__tests__/protocol.test.ts` (rename to `mcpProtocol.test.ts` if it no longer tests `protocol.ts`)

**Interfaces:** Consumes the endpoint from Task 2 through the real `handler`.

- [ ] **Step 1: Port every case** from the old file to assert behaviour (not SDK internals): `initialize` for `2025-06-18` and `2025-03-26` returns a supported `protocolVersion`, `capabilities.tools` and `serverInfo.name: "hoardwise"`; `notifications/initialized` returns 202 with an empty body; `ping` works; `tools/list` hides tools the scope may not call; `tools/call` content and `structuredContent`; an unknown tool and a tool the scope may not use are errors; `{ ok: false }`, a throw, a BigInt result, an `undefined` outcome and a result over 200,000 characters each give `isError: true` with no message, stack or argument in the body or in `console` calls; invalid JSON, a missing or non-string `method`, an object `id` and an unknown method each give a JSON-RPC error (status as the SDK defines, but never 500) with no input echoed; a `tools/call` with no `id` is a notification and never runs the tool. For JSON-RPC batches record what the SDK actually does; if it accepts one, decide with a test whether to refuse it in `handler.ts` (the 2025-06-18 revision removed batching) and note the decision in the commit body.
- [ ] **Step 2: Run** `yarn vitest run src/mcp`. Expected: cases that differ because the SDK words an error differently are adjusted to assert the stable part (error code or `isError`), and nothing is deleted without being replaced. FAIL first where behaviour really differs; fix the code in Task 2's files if a safety behaviour is lost.
- [ ] **Step 3: Run** `yarn test`. Expected: PASS.
- [ ] **Step 4: Commit** `test: port the MCP protocol tests to the SDK endpoint (HOA-11)`.

### Task 4: Verify end to end, update the records

**Files:**
- Modify: `SECURITY.md` (AUTH-18), `CHANGELOG.md`, `docs/superpowers/plans/2026-10-31-mcp-endpoint.md` (one note at the top that the protocol layer was replaced by this plan)
- Test: `src/mcp/__tests__/mcpEndToEnd.test.ts` must pass unchanged

- [ ] **Step 1: Run** `yarn typecheck`, `yarn test`, `yarn build` (dummy Auth0 env), `yarn build:container`, `yarn build:demo` (with `VITE_AUTH0_*` unset) and the demo-bundle check that no MCP or SDK code is in `build/demo`. Expected: all pass.
- [ ] **Step 2: Manual check, not CI:** as in plan 1 Task 8 (built container, `AUTH_MODE=local`, a new temp data directory under the scratchpad, a read token that is never printed, port above 1024): `initialize`, `tools/list`, `month_review`; no token gives 401; `GET` gives 405; confirm the reply is `application/json` and not an event stream. If you can, also invoke the built Lambda entry (`require('./build/api/index.js').handler`) once with a hand-made API Gateway v2 event for `POST /mcp` and confirm the same JSON reply.
- [ ] **Step 3: Update `SECURITY.md` AUTH-18** to say `/mcp` is served by the official SDK at a pinned version, and that authentication, scope checks, `Origin`, limits and logging remain Hoardwise's own code in front of it; add a CHANGELOG line.
- [ ] **Step 4: Commit** `docs: record the MCP SDK in AUTH-18 and the changelog (HOA-11, AUTH-18)`.

---

## Self-review notes

- **Spec coverage:** SDK for `/mcp` (Tasks 1 to 3), pinned version, licence, tree and bundle cost (Task 1), unchanged safety rules (Global Constraints, Review Focus, Task 2 tests), records (Task 4). The OAuth resource-server pieces (`requireBearerAuth`, protected-resource metadata, `scopeChallenge`) belong to plan 2, where tokens issued by us are verified.
- **Linear:** HOA-11 ("use the official TypeScript MCP SDK") now matches the work; its text still says "in the container" and should be widened to both deployments.
- **Calls I made in this plan:** build the handler once per module load with a per-request server factory; pass the token's database id, never the raw token, as `clientId` in `authInfo`; keep our own 413 as well as the SDK's cap; refuse JSON-RPC batches if the SDK would accept them; stop and report if the build chain needs a bundler.
