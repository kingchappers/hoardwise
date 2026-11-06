# Changelog

Releases of the self-hosted container image (`ghcr.io/kingchappers/hoardwise`; releases up to 0.2.0 were published as `ghcr.io/kingchappers/budget-app-v3-ai-edition`). Versions follow `vX.Y.Z` tags; `edge` is the latest `main` and is not a release. See "Upgrading" in [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) before you update, and take a backup first.

## Unreleased

Not in the image yet, or not part of it:

- **Browser demo.** A separate static build of the app with an invented household, running entirely in the visitor's browser. It is published at https://demo.hoardwise.xyz (the original https://demo.budget.scgrid.xyz keeps working for now) and is not part of the container image.
- **Brand kit.** The app has its logo, icons, favicons, link-preview image and Lora typeface, and a green and gold palette in light and dark mode. The lockup is in the header, the sign-in screens and the demo banner.
- **Personal API tokens.** The API accepts personal access tokens. They are read-only by default, with optional write tokens (self-hosted write tokens need your password), expire after 90, 180, 365 or 730 days or never, can be revoked, and are all revoked by a password reset. Create and revoke them under Settings > Access tokens.
- **Empty database beside a populated one.** If an empty `hoardwise.sqlite` was created next to an older install's `budget.sqlite`, the app now keeps using `budget.sqlite` and logs that it did, instead of starting on the empty file. Neither file is changed.
- **API description.** `docs/openapi.yaml` describes every route (OpenAPI 3.1); tests fail if it drifts from the code.
- **API docs.** Logged-in users can read the API reference in the app on the Docs page (Settings > API docs). The same description is served at `GET /api/openapi.json` and a guide for AI agents at `GET /api/docs/agents`, both behind login or an access token. The browser demo does not include them.
- **Agent skill.** A Claude Code plugin, installable from this repository, teaches an agent to review your month through the API in a calm, short way, and to log a spend when you ask.
- **Weekly image scan.** The published `latest` and `edge` images are scanned for high and critical vulnerabilities every Monday.
- **MCP endpoint.** `/mcp` lets an AI assistant review your month with a personal access token: read tokens call read tools and keep graphic styles, and, with a write token or a "View and change" connection, spends and incomes can be saved; it is rate limited (on AWS, also throttled at the gateway). The protocol is served by the official MCP SDK (`@modelcontextprotocol/server`, Apache-2.0, pinned to an exact version), which adds about 17 MB unpacked to the Lambda and the image (the zipped Lambda grows about 3.4 MB); token checks, scopes and limits are still Hoardwise's own code.
- **Sign in for AI assistants.** An assistant such as Claude can connect to `/mcp` by signing in instead of pasting a token: it registers itself, you approve it on a consent page (read-only, or read and write, which asks for your password when the install uses the built-in login), and it gets a one-hour access token with a 90-day rotating refresh token. Each connection shows in Settings > AI assistants and can be revoked there. It is off until `APP_ORIGIN` is set (container: the public origin or `TLS_DOMAIN`; on AWS, set the repository variable `APP_ORIGIN` to the site's public origin). The browser demo does not include it.
- **Graphic styles and logging through the assistant.** You can ask the assistant to save a graphic style by name and make it your default, and it will use that style the next time it draws a chart; this works with "View only" too. With "View and change" (or a write token), you can ask it to log a spend or an income: it reads the entry back and waits for your yes, and a retry of the same request does not create a second entry. The date is always required. Known limits: changing the date to another month, or retrying after you deleted the entry, can create another entry. It cannot edit or delete money entries. Styles are included in export and import.

## 0.3.0 - 2026-10-27

The app is now called **Hoardwise**.

- **The image is renamed** to `ghcr.io/kingchappers/hoardwise`. Update the `image:` line in your compose file; see "Upgrading" in `docs/SELF-HOSTING.md`. The old name `ghcr.io/kingchappers/budget-app-v3-ai-edition` keeps its existing tags (`0.1.0`, `0.2.0`, `latest`) but gets no further updates.
- The repository is now `kingchappers/hoardwise`; the old address redirects.
- **Self-hosted sign-in cookie renamed.** The session cookie is now `hoardwise_session` (`__Host-hoardwise_session` over HTTPS), so everyone signs in once more after updating.
- **Database and backup names.** New installs create `hoardwise.sqlite` and `hoardwise-…` backups. An install that already has `budget.sqlite` keeps using it, and older `budget-…` backups are still kept, restored and pruned. Nothing is renamed on disk.
- **Saved browser settings** (preferences, snoozed bills and similar) move to new names the first time the app loads, with nothing lost.
- **Rolling back.** If you go back to a version before 0.3.0 after updating, you sign in again and settings changed since the update (browser preferences) are not carried back. An install that kept its `budget.sqlite` is untouched by going back. A brand-new 0.3.0 install has `hoardwise.sqlite`, so it cannot be taken back to a version before 0.3.0 without its data being left behind in that file.
- Apart from the `image:` line, nothing else is needed on upgrade: your data, backups and account carry over.

## 0.2.0 - 2026-10-17

Made the image workable on hosts that give you no shell, such as PikaPods.

- **Password recovery without a shell.** Create an empty file named `RESET_PASSWORD` in the data folder and restart. The app deletes it, signs everyone out, clears any login lock-out and logs a one-time recovery code (also saved as `SETUP_CODE.txt`). Entering that code on the sign-in page sets a new password; your account and data are unchanged.
- **Setup and recovery codes** appear in the log and in `SETUP_CODE.txt` (owner-only, removed once used).
- **`TRUST_PROXY`** accepts only `true` or `false`.
- Documentation for running on a managed host, including where to find the log and the data folder.
- Database schema: unchanged from 0.1.0.

## 0.1.0 - 2026-10-17

First release of the self-hosting image.

- The app and its API in one container for `linux/amd64` and `linux/arm64`, running as a non-root user.
- SQLite storage in `/data`, with an automatic daily backup.
- Built-in single-account login, so no Auth0 account is needed.
- Optional automatic HTTPS (set `TLS_DOMAIN`), or plain HTTP behind your own reverse proxy.
- Licensed AGPL-3.0-or-later.
