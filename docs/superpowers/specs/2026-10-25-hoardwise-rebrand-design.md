# Hoardwise rebrand design

Linear: HOA-16 (this work), HOA-30 (domain move, separate), HOA-31 (artwork, separate).

## Goal

Rename the product to **Hoardwise** everywhere a person meets it, before hosting partners such as PikaPods see the repository, without logging anyone out, losing data or breaking existing installs.

## Decisions already made

- **Scope.** Rename everything visible, the public identity (container image, GitHub repository, package name) and the internal browser and self-hosted names (browser storage keys, SQLite file, backup file names, session cookie). AWS resource names are not renamed.
- **Delivery.** Three staged pull requests, in this order: (1) internals with fallbacks, (2) the visible rebrand, (3) public identity, released as `v0.3.0`.
- **Old image name.** Stop publishing under `ghcr.io/kingchappers/budget-app-v3-ai-edition`. Its existing tags stay pullable and are frozen. Nobody but the owner uses them. No dual publishing.
- **New names.** Repository `kingchappers/hoardwise`, image `ghcr.io/kingchappers/hoardwise`.
- **Artwork and colour.** Not part of this work. The existing icons and the teal theme colour (`#0f766e`) stay as placeholders; HOA-31 replaces them.
- **Domain.** Not part of this work (HOA-30). The live site stays at `budget.scgrid.xyz` and the demo at `demo.budget.scgrid.xyz` until then.
- **Session cookie.** Renamed with no fallback; one re-login on self-hosted installs.
- **SQLite file.** Existing installs keep `budget.sqlite`; it is never renamed.

## Non-goals

- Renaming AWS resources. `infra/dynamodb.tf` derives the table name from `var.app_name`, and a changed name makes OpenTofu replace the production table with an empty one. The example `app_name` gets a comment saying so.
- Renaming the feature word "budget" (budgets, "Budget for Groceries", the glossary term). The product is renamed, not the concept.
- Renaming the IndexedDB database. It is called `offline-transaction-queue` and carries no brand, so unsent offline entries are untouched.
- Environment variables. None of them carries the old name, so no aliases are needed.
- The Cloudflare Pages project `budget-demo` and `DEMO_MARKER` (`budget-demo-build-7f3a9c`). Both are internal; neither is user-visible.
- Compose example volume names `budget-data` and `budget-backups`. Renaming them would make anyone who re-copies the new example over their own file silently get an empty volume. The service name is renamed; the volumes are not.

## PR 1: internal names with fallbacks

### Browser storage keys

In use today, in `localStorage`: `budget.preferences`, `budget.targetsCardDismissed`, `budget.openAddOnLaunch` (an older setting that `app/lib/preferences.ts` still reads), and the per-user families `budget.billSnoozes.<id>` and `budget.billDismissedMatches.<id>`. In `sessionStorage`: `budget.pendingAdd`, `budget.launchHandled` and `budget.transactionDraft`.

- New prefix: `hoardwise.`.
- A migration runs once at app start, before anything reads storage. For each `budget.*` key in `localStorage`, copy the value to the matching `hoardwise.*` key if that key is absent, then remove the old key. The per-user families are matched by prefix. The migration tolerates unavailable or throwing storage, as `app/lib/preferences.ts` already does.
- The inline script `TEXT_SIZE_SCRIPT` in `app/lib/textSize.ts` reads the preferences key before the page paints, so it reads `hoardwise.preferences` and falls back to `budget.preferences`. Otherwise the text size would flash wrong on the first load after the update.
- The three `sessionStorage` keys last one tab session, so they are renamed with no migration.

### SQLite file and backups

- File choice at start-up: if `<DATA_DIR>/hoardwise.sqlite` exists, use it. Otherwise, if `<DATA_DIR>/budget.sqlite` exists, use that. Otherwise create `hoardwise.sqlite`. The decision lives in `container/config.ts`.
- Existing files are never renamed. A rename must also move the `-wal` and `-shm` files, and a crash between the moves can lose recent writes.
- If both files exist (a deliberate restore), use `hoardwise.sqlite` and log a warning that names both. Exception (HOA-41): when `hoardwise.sqlite` is readable and holds no rows in `items` while `budget.sqlite` holds some, use `budget.sqlite` and log a warning saying so, because the empty file was almost certainly created by mistake on an older install. Both files are opened read-only for that check, and a file that cannot be read keeps the default rule.
- The container sets `SQLITE_PATH` itself from this choice and does not read it from the environment. The store command-line tool still takes an explicit `SQLITE_PATH`, unchanged. `parseConfig` stays free of side effects: it takes an injectable file-exists check, defaulting to `existsSync`, and never creates, renames or deletes a file.
- New backups are named `hoardwise-YYYYMMDD-HHMMSS.sqlite`. `BACKUP_PATTERN` in `src/store/backup.ts` becomes `/^(?:budget|hoardwise)-\d{8}-\d{6}\.sqlite$/`, so old backups are still listed, pruned and found by the "newest backup" check, and pruning still never touches a file that does not match.
- The documentation's command lines that name the database file say "`hoardwise.sqlite` (`budget.sqlite` on installs created before 0.3.0)".

### Session cookie

`src/auth/cookies.ts` renames `budget_session` to `hoardwise_session` and `__Host-budget_session` to `__Host-hoardwise_session`. Self-hosted installs only: the AWS deployment authenticates with Auth0 tokens. Everyone is signed out once after updating. The server never accepts the old name; adding a second accepted name to the credential check is attack surface we do not want for a one-off re-login.

### Tests (PR 1)

- Storage migration: old key only, new key only, both present (new wins, old removed), neither, per-user keys, and storage that throws.
- Text-size script: reads the new key, falls back to the old.
- SQLite choice: the four combinations of the two files existing, with the both-exist warning.
- `BACKUP_PATTERN`: both prefixes accepted, an unrelated file rejected, and pruning leaves unrelated files alone.
- A server test that starts on a data folder containing only `budget.sqlite` and still reads the existing data.
- Cookie tests updated for the new names.

## PR 2: visible rebrand

- `APP_NAME` in `app/lib/pageTitle.ts` becomes `Hoardwise`. The header wordmark in `app/components/layout/DefaultLayout.tsx` and the `apple-mobile-web-app-title` meta tag in `app/root.tsx` use the constant instead of their own copies.
- Add `application-name`, `og:title` and `og:description` meta tags.
- `public/manifest.webmanifest`: `name` and `short_name` become `Hoardwise`; add a `description`.
- About page copy ("Budget is a small app…") names Hoardwise. The About page images show the old wordmark, so they are regenerated with `yarn screenshots` (this needs Playwright's Chromium installed once).
- `public/sw.js`: the fallback reminder text "Open Budget to see what is due." names Hoardwise.
- Calendar export (`app/lib/ics.ts`): the calendar name, description and `PRODID` name Hoardwise. **The event `UID` suffix `@budget` stays.** Calendars use the UID as an event's identity, so changing it would make a re-import create duplicates of every bill.
- Login, setup and recovery screens take their titles from `pageTitle`, so they inherit the change; they are checked for stray literal copies.
- The demo banner and seeded copy are checked for the old name.
- A test asserts that the manifest `name` equals `APP_NAME`, so the two cannot drift apart; existing assertions on titles are updated.

## PR 3: public identity, released as v0.3.0

- `package.json` name and description.
- Container image name `ghcr.io/kingchappers/hoardwise` in `.github/workflows/container.yml` (`IMAGE`), the weekly scan workflow, the compose examples and the documentation. OCI labels (title, source URL) name Hoardwise and the new repository. CI's local image tag and the `budget-caddy-` temporary-directory prefix are renamed.
- Compose examples: the service `budget` becomes `hoardwise`, and every documentation command that says `docker compose exec budget` is updated. Volumes keep their names (see Non-goals).
- Documentation: `README.md`, `docs/SELF-HOSTING.md`, `SECURITY.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CLA.md`, repository URLs everywhere.
- `CHANGELOG.md` gets a `0.3.0` entry: the image is renamed and the old name is frozen; sessions on self-hosted installs end once; existing databases and backups keep working; nothing else to do on upgrade. `docs/SELF-HOSTING.md` "Upgrading" says to change the image name in the compose file, and that the volumes are not renamed.
- `infra/terraform.tfvars.example` keeps `app_name` with a comment explaining why it must not change.
- The container smoke tests and CI scan use the new image name.

## Rollout sequence

1. Merge PR 1, then PR 2. Both deploy to the live site through CI; PR 2 makes `budget.scgrid.xyz` say Hoardwise.
2. The owner renames the GitHub repository to `hoardwise` just before PR 3 merges, so every link in the merged documents is correct at once. GitHub redirects the old repository URL. The local clone's remote is updated.
3. Merge PR 3. The next push to `main` publishes `edge` under the new image name.
4. Tag `v0.3.0`, which publishes `latest`. This happens before the next Monday, because the weekly scan looks for `latest` under the new name.
5. The owner makes the new GHCR package public in its settings (a new package starts private).

## Risks and how they are handled

- **Preferences or snoozes lost.** Mitigated by the copy-then-remove migration and its tests; storage unavailability is tolerated.
- **Text size flashes wrong on first load.** Mitigated by the fallback in the pre-paint script.
- **Data stranded after a file rename.** Avoided by never renaming existing database files.
- **Old backups ignored or never pruned.** Avoided by accepting both prefixes in `BACKUP_PATTERN`, with tests.
- **Calendar duplicates.** Avoided by leaving the UID suffix alone.
- **Production table replaced.** Avoided by not touching `app_name`, with a warning comment.
- **Weekly scan fails before the new image exists.** Avoided by the sequence above (tag before Monday).
- **A broken link between the repository rename and the merge.** Avoided by renaming just before PR 3 merges.

## Acceptance

- No page, notification, manifest field, calendar export or document shows the product as "Budget" or "budget-app-v3-ai-edition", other than the feature word and the internal items listed under Non-goals.
- A database written by `v0.2.0` starts under the new image, keeps its data and its backups, and new backups use the new prefix.
- A browser with the old storage keys keeps its preferences after the update.
- CI is green on every PR, the production deploy succeeds after PRs 1 and 2, and the published `latest` image under the new name passes the weekly scan.
