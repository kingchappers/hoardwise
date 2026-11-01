# Connect AI assistants to Hoardwise over MCP (HOA-10 to HOA-15)

## Why

The Hoardwise skill (HOA-8) lets Claude Code answer "how am I doing this month?" in a calm, short way. Most people do not use Claude Code. They use Claude on their phone, desktop or the web, and those apps reach outside data only through a connector: a remote MCP server they add by URL. This work builds that connector, so the same calm review is available from any Claude app, and so an assistant can help someone see their spending in a way that suits how their mind works.

The product is built for ADHD and autistic people. "Graphics that work" differ between individuals, so Hoardwise does not pick one chart style. The assistant offers options, the person finds what suits them, and Hoardwise remembers it.

## What the person experiences

1. **Connect, once, in a few clicks.** On the web or desktop app they paste their Hoardwise URL as a custom connector and press Connect. A Hoardwise page opens, they sign in as usual, and they see a short consent screen where they choose "view only" (the default) or "view and change". No token is copied or pasted. After that the connector also appears in the phone app (Claude mobile cannot add a new connector; it uses ones added on web or desktop).
2. **Ask questions.** "How am I doing this month?" gives the same answer shape as the skill: a short headline and up to three things worth knowing, then an offer of more detail, never the detail unasked. It uses income, category targets, pots, previous months, and big spends or deviations from the person's own pattern. Language is non-judgemental. If no income is logged for the month, the assistant asks what they expect (offering the usual amount when it is regular).
3. **Get graphics that suit them.** The assistant may offer graphics and infographics (hand the data to a design tool such as Claude's design features). The person asks for variations: fewer colours, numbers only, one big figure, a picture instead of a table. Hoardwise supplies tidy summary data and short calm-design guidance; it does not draw anything.
4. **Save a style, and make one the default.** When they like one, they say "save this as 'big number'". Later they ask for it by name, or ask "what styles have I saved?". "Always show me that one" makes it the default, used whenever a graphic is offered, until they change or clear it. Everything about styles is done by talking to the assistant. There is no screen for it in Hoardwise.
5. **Log money.** The assistant can log a **spend** and log an **income** (for example filling a month's missing income). It reads the entry back and waits for a clear yes before saving.
6. **Disconnect.** Each connected assistant shows in the existing access-tokens list in Settings, where the person can revoke it.

## Goals

- Works from Claude web, desktop and mobile (a connector added on web or desktop), and from Claude Code, against **both** the AWS-hosted and self-hosted deployments, from one shared implementation.
- Sign-in by OAuth 2.1, so connecting needs no copied token. Personal tokens (`hwr_` and `hww_`) keep working for Claude Code, scripts and other agents on the same endpoint.
- Read-only by default, chosen on the consent screen.
- A small set of tasks-shaped tools (about six to eight, HOA-10), not one tool per API route.
- Saved graphic styles stored in Hoardwise, per person, so they follow the person across assistants.
- The recorded behaviour from HOA-8 carries over: short first answer, offer detail rather than show it, non-judgemental wording, income prompt, patterns across months.
- A comparison of this against the skill using real prompts (HOA-14) so we know where each is better.

## Non-goals

- Drawing charts in Hoardwise. The assistant and a design tool do that.
- A Settings screen for styles, or for anything the person can do by asking.
- Writing to anything beyond spends, incomes and saved styles. No editing or deleting past entries, no changes to pots, targets, accounts or categories. These can come later.
- Anything in the browser demo (no `/mcp`, no OAuth, no styles), as with tokens and the API docs.
- Connectors for other products (ChatGPT, Cursor) beyond what works with a standard remote MCP server and OAuth.
- Server push, long-lived streams, or MCP features that need a persistent connection (see "Stateless").

## Anti-goals

The person must never be able to say any of these:

- **My data leaked.** Any route that shows one person's data to another person, to an unauthenticated caller, to a different Hoardwise instance, or to a log. A token, code or secret appearing in a log, error, tool result or commit.
- **My Hoardwise went down.** An unauthenticated or low-cost request that does expensive work, an unbounded response, an unbounded table of registrations, or a flood that exhausts a self-hosted container or runs up an AWS bill without limit.
- Beyond those two (the builder should treat them as the core): an assistant that writes without a clear yes, obeys instructions found inside a payee name or description, makes judgemental statements about spending, or overwhelms with detail.

## Constraints and what already exists

- The API handlers in `src/api/` serve both deployments (`api-handler.ts` on Lambda, `container/` on self-hosting). The MCP and OAuth routes belong in the same shared code.
- Tokens: `src/auth/tokens.ts`, `src/auth/tokenAuth.ts`, `src/api/tokens.ts`. Read tokens may only GET/HEAD. `NON_TOKEN_PATHS` in `tokenAuth.ts` keeps tokens away from `/api/auth`, `/api/tokens` and `/api/push`. `src/api/tokenRouter.ts` is the allow-list of routes a token can reach; a route not added there is unreachable by tokens.
- The `Store` interface (`src/store/types.ts`) has DynamoDB, SQLite and in-memory implementations; new stored data (OAuth codes, clients, styles) goes there with the same expiry and hashing practices as tokens.
- Two auth modes exist: Auth0 and the built-in local login (`AUTH_MODE=local`). The consent step has to work in both.
- Lambda cannot hold a connection open. The `/mcp` endpoint must be **stateless**: each request is self-contained and gets one complete JSON reply (Streamable HTTP allows this), no sessions kept in memory.
- AWS routes: API Gateway forwards only `/api/{proxy+}` to the API Lambda; everything else goes to the static Lambda (`infra/api-lambda.tf`). OAuth discovery lives at `/.well-known/...` at the root, and `/mcp` is not under `/api`, so new routes and permissions are needed in OpenTofu. INFRA-01 (least privilege) applies.
- The container adapter already caps request bodies (1 MB by default, `container/adapter.ts`).
- SECURITY.md: reference control IDs; each new route needs a row or an update (AUTH-17 covers the docs routes).
- Brand and tone: `docs/brand.md`; the skill's wording rules for answers.
- Claude's connector callback is `https://claude.ai/api/mcp/auth_callback` and may change to `https://claude.com/api/mcp/auth_callback`; accept both. Claude may register itself automatically (dynamic client registration) or the person may enter a client ID and secret by hand.

## How it is split

One design, three plans, built in this order:

1. **The `/mcp` endpoint and the read tools**, usable with a personal token. Covers HOA-10 and HOA-11 (HOA-11 widens from "container" to both deployments), the stateless transport, limits, and the tool set for questions and graphics data. A first useful milestone: Claude Code can already use the endpoint.
2. **OAuth sign-in** (HOA-15, moved into this milestone and raised from Low): discovery documents, client registration, authorization with a consent screen (view only / view and change), token issue and refresh, revocation through the existing tokens list. Also HOA-13's "AI assistants" settings page with connection instructions.
3. **Write tools**: the saved-style tools (list, save, rename, delete, set default, clear default; allowed in view only), then log a spend and log an income (view and change only), plus the confirm-before-write rules (HOA-12 completes here). HOA-14's comparison against the skill runs when the read tools and the write tools both exist.

## Safety rules

**Nothing leaks:**
- A tool acts only on the person the connection belongs to. No tool takes a user id as input.
- OAuth done properly: PKCE required; redirect addresses matched exactly against those registered; short-lived, single-use authorization codes; issued tokens bound to this instance (the audience) and stored hashed; no token or code in a log line, error message or tool result.
- The consent screen is the only place scope is chosen. A "view only" connection cannot change the budget: it cannot call the spend or income tools. It can list, save, rename, delete and set the default of graphic styles, because those never touch money (decided by you).
- Transaction descriptions, payees, memos and style text are data to the assistant, never instructions. Tool results mark them as data.
- Saved style text is length-limited and plain text only (no markup, no links).

**Nothing falls over:**
- Rate limits and body-size caps on `/mcp` and every OAuth route. Unauthenticated routes (discovery, registration, token exchange) do the least work and have the tightest limits.
- Client registration is capped and unused registrations expire.
- Every tool has a ceiling on what it fetches (the existing 24-month range cap is the model) and replies have a size cap.
- On AWS, a concurrency limit on the relevant routes so a flood has a bounded cost.
- A failing tool returns a plain error and never crashes the process.

## Decisions

**Yours:** people ask questions in the skill's calm style; graphics come from the assistant and a design tool, not Hoardwise; the person finds the style that suits them, saves it by name, and can make one the default; styles live in Hoardwise; styles are managed only by asking the assistant; OAuth is part of this work; the assistant may log spends and incomes and save styles, nothing else; it works on both AWS and self-hosted; the worst failures are a data leak or taking an instance down; the official MCP SDK is used for `/mcp` and the resource-server side of OAuth, and we write the token-issuing endpoints ourselves.

**Mine, for you to check:**
- View-only is the default on the consent screen, and consent is the single place scope is chosen. **Yours:** view-only connections may manage graphic styles.
- The read-only connection can still read styles and apply the default.
- A saved style is a name, a short plain-text description of the look and a default flag, not an image or data; a small cap on how many a person can keep.
- Connected assistants appear in the existing tokens list rather than a new screen.
- Stateless `/mcp`, with no streaming.
- The three-plan order above, and widening HOA-11.
- Raising HOA-15 out of Low and moving it into this milestone.

## Settled after the builder check

These are my calls, so please check them.

- **Who enforces "wait for a yes".** The server cannot hear the person. Each write tool is marked as a change in its MCP tool annotations, so the Claude app asks the person to approve the call, and its description tells the assistant to read the entry back first. The server adds idempotency: a spend or income carries a `transactionId`, so a repeated call does not create a duplicate. There is no separate preview-then-commit tool pair.
- **Where the review is worked out.** The server works out the figures: this month against the person's usual month, each category against its target and its usual level, pot movements, and a short list of unusual items, using the rules written in the HOA-8 skill (`plugins/hoardwise/skills/budget/review.md` is the reference). The assistant words the answer, following guidance the server supplies, so a phone assistant with no skill file still answers the same way.
- **What logging writes.** The spend and income tools reuse the existing transaction handlers and validation, so side effects (pots, recurring items) are the same as in the app. The assistant picks the category and account from the person's own lists and asks when it is unclear.
- **Personal tokens on `/mcp`.** `/mcp` is a deliberate exception to "read tokens may only GET/HEAD", because MCP sends everything as POST. The rule moves into each tool: `hwr_` tokens (and OAuth "view only") can call the read tools and the style tools, and `hww_` tokens (and OAuth "view and change") can call the spend and income tools too. This makes style tools the one place a read token may write, which is deliberate and limited to the person's own style records. `tokenRouter.ts`, `NON_TOKEN_PATHS` and the SECURITY.md rows are updated to say so, with a test that a read token cannot reach the spend or income tools or any other budget write.
- **One person or many.** Design for many. An instance can hold several people (Auth0 always does; the local login can too), so every stored record (OAuth codes, clients, styles) is keyed by user.

## The official MCP SDK (decided after plan 1 was first built)

**Yours:** use the official SDK for `/mcp` and for the resource-server side of OAuth, and write the token-issuing endpoints ourselves. The reason you gave is safety: protocol and token-verification code that many clients already use is less likely to hide a mistake than code we write once.

What this means, from checking the SDK's current state (the v2 line, `@modelcontextprotocol/server` 2.4.0, stable, for the 2026-07-28 spec, with `zod` and a core package as its only dependencies):
- `/mcp` is served by `createMcpHandler(factory, options).fetch(request, { authInfo })`, which takes a Web-standard `Request` and returns a `Response`. Our code converts the API Gateway event (or the container's request) to a `Request` and back. Use `responseMode: 'json'` so every call gets one complete JSON reply and `maxRequestBodySize` set to the 64 KiB cap. That handler serves only 2026-07-28 requests (`legacy: 'reject'`): the SDK's own stateless legacy path would answer 2025-era clients with an event stream, so Hoardwise picks those out with `isLegacyRequest` and serves each through its own per-request `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse: true`. Hoardwise answers `GET` and `DELETE` with 405 itself, before the SDK.
- A fresh `McpServer` is built for every request, so which tools are registered can depend on the token's scope (a tool the connection may not use is simply not registered).
- Token verification stays ours (the SDK passes `authInfo` through and never reads headers itself); the SDK's `requireBearerAuth`, `scopeChallenge` and the protected-resource metadata helpers are used where they fit.
- The SDK does not issue tokens ("it verifies access tokens that an authorization server issued, and it never issues them"). The old helper for that (`mcpAuthRouter`, in `@modelcontextprotocol/server-legacy`) is Express-based and described as frozen, so plan 2 writes the authorize, token, register and revoke endpoints itself, reusing Hoardwise's hashed and revocable tokens and its login, with well-tested libraries (for example `jose`) for the token and key work.
- The dependency is pinned to an exact version, its licence (Apache-2.0, which is compatible with this repo's AGPL-3.0-or-later; checked when the dependency was added) and dependency tree are checked, and the Lambda bundle size and the container image are compared before and after.
- Open risks the builder must settle first: the Lambda and container builds compile with `tsc --module commonjs` (no bundler), and the SDK is an ES-module package with an `exports` map, so type resolution and the CommonJS build may need a change; the SDK's JSON response mode must be confirmed to work behind API Gateway's HTTP API.

The hand-written protocol layer in plan 1 (`src/mcp/protocol.ts` and the parsing in `src/mcp/handler.ts`) is replaced by this; the tools, review code, data loading and tests of their behaviour stay.

## Left to the builder

- Exact tool names, inputs and outputs (about six to eight task-shaped tools, HOA-10), and what summary data the graphics guidance returns.
- Settled by plan 2 (OAuth, HOA-15, with the Settings page HOA-13):
  - **Specs targeted.** Authorization code flow with PKCE `S256` for public clients only, dynamic client registration (RFC 7591) and the two discovery documents (RFC 9728 protected resource, RFC 8414 authorization server), plus RFC 7009 revocation. No client ID metadata documents (CIMD) yet: that needs the server to fetch a URL the client supplies, which is a server-side request forgery risk to design separately.
  - **Routes.** Discovery at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`; `POST /api/oauth/register`, `/token` and `/revoke` are public; `GET /api/oauth/client` and `POST /api/oauth/authorize` need a signed-in user. On AWS each public route is an explicit API Gateway route with its own throttle.
  - **Storage.** Clients, codes and refresh rows live under `OAUTH#` partitions in both Store implementations; the access token is an ordinary hashed token row.
  - **Lifetimes.** Access token 1 h, refresh token 90 days and rotating (reuse revokes the connection), authorization code 60 s and single use, unused client 24 h. A connection is one row in the tokens list with `kind: 'oauth'`.
  - **Numbers.** 500 registered clients (oldest unused evicted), 10 registrations per address per hour, 30 token and 30 revoke attempts per address per 10 minutes, 8 KiB request bodies.
  - **Consent.** The SPA route `/connect`, in both auth modes; local mode asks for the password again to grant write.
  - **Off by default.** Unset `APP_ORIGIN` answers 404 on every OAuth route.
- Style cap and the exact rate limits and size caps for the tools themselves.
- Test strategy, including a conformance check against a real MCP client or the MCP inspector.

## Related

HOA-8 (skill, done), HOA-5/6 (tokens, done), HOA-7 (OpenAPI, done), HOA-9 and HOA-50 (API docs, done), HOA-10 to HOA-15, HOA-21 (Caddy bump, due 2026-11-07; unrelated but dated).
