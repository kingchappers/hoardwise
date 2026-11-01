# Self-hosting

## What you get

One container that serves the app and its API, keeps your data in a SQLite database on a volume, and signs you in with a built-in single-account login (no Auth0 or other account needed). It can obtain and renew an HTTPS certificate for your domain itself, and it takes a backup of the database every day. Push reminders are not in this release.

The image is `ghcr.io/kingchappers/hoardwise`, tagged `latest`, `X.Y.Z`, `X.Y` and `edge` (the latest `main`). It is licensed AGPL-3.0; the source is at <https://github.com/kingchappers/hoardwise>.

> The image is built by CI from the repository's Dockerfile. It has been built and smoke-tested locally on arm64 only. The CI workflow, the published GHCR image and the amd64 build are unverified until the first CI run; report anything that does not match. <!-- REMOVE when the first CI run has built, smoke-tested and published the image -->

## Quick start

1. Copy [`compose.example.yml`](../compose.example.yml) to `compose.yml` and set `TLS_DOMAIN` (and `TLS_EMAIL`). The domain's DNS must point at this machine, and ports 80 and 443 must be reachable from the internet. Without a domain, see [HTTPS](#https).
2. `docker compose up -d`
3. Find the one-time setup code: in the log (`docker compose logs hoardwise`, look for the line starting `Setup code:`), or in the file `SETUP_CODE.txt` in your data folder.
4. Open the app in your browser and create your account with the setup code. The setup page closes once an account exists, except for marker-file recovery (see [Forgot your password](#forgot-your-password)).

## Configuration

Environment variables only. The container sets `AUTH_MODE`, `STORE` and `SQLITE_PATH` itself; you do not.

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/data` | Volume holding the database (`hoardwise.sqlite`; an install created before 0.3.0 keeps its `budget.sqlite`, which is used as it is and never renamed; if both files are present the app uses `hoardwise.sqlite`), backups, the `caddy/` certificate storage and `caddy-data/` (Caddy's own data directory, such as its instance id). An absolute path using only letters, digits and `. _ / -`, with no `..` segment and not `/` |
| `PORT` | `8080` | Port the app listens on inside the container. Must be a fixed port (not 0) with `TLS_DOMAIN` |
| `TLS_DOMAIN` | unset | A plain hostname such as `hoardwise.example.com` for automatic HTTPS on ports 80 and 443. Unset means plain HTTP |
| `TLS_EMAIL` | unset | Optional contact address for the certificate authority. Needs `TLS_DOMAIN` |
| `APP_ORIGIN` | `https://$TLS_DOMAIN` when that is set | The public URL (scheme, host, port; no path). When set, the `Origin` of every state-changing request must match it exactly. Must match `TLS_DOMAIN` and be `https` if that is set |
| `TRUST_PROXY` | `true` with `TLS_DOMAIN`, otherwise `false` | Honour `X-Forwarded-*` headers. Turn it on only behind a proxy you control |
| `COOKIE_SECURE` | derived | `true` exactly when the effective origin is `https`. An explicit `true` or `false` overrides this |
| `BACKUP_HOUR` | `3` | Hour (0-23, in `TZ`) from which the daily backup is due (taken at the first hourly check from then on) |
| `BACKUP_KEEP` | `7` | Number of newest backups kept (0-365). `0` turns backups off |
| `BACKUP_DIR` | `$DATA_DIR/backups` | Where backups are written |
| `TZ` | `UTC` | Timezone for the backup hour |

A bad value stops the container at start with a message naming it.

Listening address: without `TLS_DOMAIN` the app listens on all IPv4 interfaces inside the container, on `PORT` (default 8080). With `TLS_DOMAIN` it listens on loopback only and Caddy, bundled in the image, serves ports 80 and 443.

Limits: request bodies over 1 MiB are rejected before the app sees them. A client that is still uploading when the limit is hit may see a connection reset instead of a 413 response.

A bind-mounted data directory (instead of a named volume) must be owned by the app user, uid and gid 10001: `chown -R 10001:10001 ./data`. A named volume is set up correctly by the image.

If you mount the root filesystem read-only, keep `/tmp` writable (the generated Caddyfile and Caddy's config directory live there) as well as `/data`.

## HTTPS

Automatic HTTPS (`TLS_DOMAIN`) needs a public domain pointing at the machine and ports 80 and 443 reachable from the internet, so the certificate authority can verify the domain. Port 443/udp serves HTTP/3 and is optional (publish it as `443:443/udp`). Certificates are stored in `$DATA_DIR/caddy` and survive restarts and upgrades. Only automatic certificates are supported: no bring-your-own certificate files, DNS challenges or wildcards.

On a home network without that, you have two options:

- **Plain HTTP** (`TLS_DOMAIN` unset, see [`compose.plain.example.yml`](../compose.plain.example.yml)). Cookies are then not `Secure`, so only do this on a network you trust. With no `APP_ORIGIN` the container logs a warning at start, and the `Origin` check compares against the `Host` header instead.
- **Your own proxy** in front (next section), with `APP_ORIGIN` set to the public https URL.

Do not expose the app to the internet over plain HTTP.

The bundled Caddy binds ports 80 and 443 as a non-root user through a file capability, which `no-new-privileges` ignores. That only matters on hosts where `net.ipv4.ip_unprivileged_port_start` is above 80; Docker sets it to 0 inside containers by default, so plain Docker or compose with `no-new-privileges` still binds. If Caddy fails to bind 80/443, use plain HTTP behind your platform's own proxy, or set `net.ipv4.ip_unprivileged_port_start=0` for the container (`sysctls:` in compose).

## Behind your own reverse proxy

Run the plain-HTTP variant and let your proxy terminate HTTPS:

- Set `APP_ORIGIN` to the public URL, for example `https://hoardwise.example.com`. Cookies are then `Secure` and `__Host-`-prefixed, and the `Origin` check requires an exact match with it.
- **Publish the port on loopback only** (`127.0.0.1:8080:8080`, as in the compose file) when the proxy runs on the same host. If it runs elsewhere, use a private network or a firewall, and only then publish on a specific private address. Never publish this port to the internet: with `TRUST_PROXY` on, the app believes `X-Forwarded-*` headers from whoever can reach it.
- Set `TRUST_PROXY=true` only if the proxy sets `X-Forwarded-*` itself and nothing else can reach the app's port.
- Forward the original `Host` header.
- The session cookie is named `__Host-hoardwise_session` and is `Secure` only when the effective origin is https. With plain HTTP and no `APP_ORIGIN`, it is named `hoardwise_session`, is not `Secure`, and the container logs a warning at start. If you are behind HTTPS but cannot set `APP_ORIGIN`, set `COOKIE_SECURE=true`.

## Connecting AI assistants

The app serves an MCP endpoint at `/mcp` (for example `https://hoardwise.example.com/mcp`) that AI assistants such as Claude can use. Settings shows the address with steps for each app.

- **Sign-in connections** (paste the address into Claude's Add custom connector) need `APP_ORIGIN` set to the public URL, or `TLS_DOMAIN`. Without either, the sign-in cannot work. The origin must be https (http is accepted only for `localhost`, `127.0.0.1` or `[::1]`); with any other plain-HTTP origin, sign-in connections stay off and personal tokens still work.
- **Personal access tokens** work without it. Make one in Settings and send it as `Authorization: Bearer <token>`.
- The per-address limits can be triggered on purpose from an address that many people share, such as a hosted client's backend. Registration allows 60 attempts per address per hour, and the token endpoint blocks an address for 10 minutes after 30 failed code exchanges. What that blocks is new registrations and code exchanges from that address for a while. Refreshes are not counted or blocked, so connections already made keep working. The real bounds are the 500-client cap (the oldest unused client is evicted at the cap) and, on AWS only, the gateway throttles. In the container, refreshes are limited only by how cheap each request is (a bad one costs up to three indexed reads and one hash).

To check the endpoint from a terminal, with `TOKEN` set to an access token:

```bash
curl -sS https://hoardwise.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A request without the `Accept` or `Content-Type` header is refused.

## Running on a managed host

Hosts such as PikaPods run the image for you and give you environment variables, a data folder and a log viewer, but no shell. Use plain HTTP (leave `TLS_DOMAIN` unset); the host's proxy terminates TLS.

- **Image and port:** `ghcr.io/kingchappers/hoardwise:latest`, listening on port `8080`.
- **Data folder:** mount a persistent volume at `/data`. Your database and backups live there.
- **Variables:** set `TRUST_PROXY=true` (it defaults to `false` without `TLS_DOMAIN`, and only the strings `true` and `false` are accepted) and `APP_ORIGIN` to the public address of your app (for example `https://my-hoardwise.example.com`). `APP_ORIGIN` makes cookies `Secure` and makes the app accept requests only from that exact origin.
- **First run:** open the host's log viewer (on PikaPods: the pod's **More** menu, then **Show Logs**) and find the line `Setup code: ...`, or open `SETUP_CODE.txt` in the data folder with the host's file manager. Enter it on the sign-in page to create your account. The file disappears once you have.
- **Forgot your password:** see [below](#forgot-your-password). You only need the host's file manager and log viewer.
- **Not available:** push reminders. Everything else works.
- **Backups:** the app writes a verified backup to `/data/backups` every day and keeps the newest seven (`BACKUP_KEEP`). Download them from the file manager and keep a copy somewhere else.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Moving from an image named `budget-app-v3-ai-edition` (versions up to 0.2.0): change `image:` in your compose file to `ghcr.io/kingchappers/hoardwise:latest`, rename the service if you want to, and pull. If you rename the service, bring it up with `docker compose up -d --remove-orphans`, so that the old container under the previous service name is removed; otherwise it keeps running and holds the same ports and data volume. Your volumes are not removed by this. The commands in this guide use the service name `hoardwise`; if you keep your service named `budget`, use that name in them instead. Keep your volume names as they are: renaming a volume starts you on an empty one. Your database, backups and password carry over; you will be asked to sign in once because the session cookie was renamed. The old image name stays available but receives no further updates.

Check [CHANGELOG.md](../CHANGELOG.md) for what changed and whether a release touches the database schema. The database schema migrates automatically at start. An older image refuses to open a database written by a newer one, with a clear message, so take a backup before upgrading and never downgrade across a schema change.

Stopping: a clean shutdown stops taking new requests (they get a 503), lets open connections finish for up to 10 seconds, waits up to 2 more seconds for requests still running, then closes the database. That is about 12 seconds in the worst case, and Docker's default stop timeout is 10 seconds, after which `docker stop` kills the process before the database is closed cleanly. The write-ahead log recovers, so no data is lost, but a clean close is better. The compose examples therefore set `stop_grace_period: 20s`; keep it, and pass `--time 20` to a bare `docker stop`. With a plain `docker run`, add `--stop-timeout 20` so the default 10 seconds does not cut the shutdown short.

## Backups and restore

> **No file name needed.** These commands find your database in the data folder the same way the app does, so they work on an install from before 0.3.0 (`budget.sqlite`) as well as a newer one (`hoardwise.sqlite`). If the database is somewhere else, they stop with "No SQLite database at ..." and create nothing, rather than leaving an empty file for the app to start on. Only `import` creates a database that does not exist yet.

- A backup is taken automatically at the first hourly check at or after `BACKUP_HOUR` (03:00 by default, in `TZ`, default UTC; the check runs hourly from when the container started) once the newest backup is older than that hour on the current day. That gives one backup per day, and a missed hour or a skipped day is made up at the next check. A backup taken before `BACKUP_HOUR` (a catch-up at start, say) counts as the previous day's, so the check at `BACKUP_HOUR` takes another. Backups go into `/data/backups`. The newest `BACKUP_KEEP` (default 7) are kept. Each is integrity-checked before it counts, so a corrupt copy never causes a good one to be pruned, and is owner-only. `BACKUP_KEEP=0` turns this off.
- File names are `hoardwise-YYYYMMDD-HHMMSS.sqlite` in local time (`TZ`). Backups made before 0.3.0 are named `budget-…`; they are kept, restored and pruned in the same way.
- At start, if there is no backup or the newest is more than a day old, one is taken straight away.
- Backups are ordered by file modification time, so do not `touch` or re-copy old backup files in the backups directory.
- For a backup on demand (the file is never overwritten, so use a new name):

  ```bash
  docker compose exec hoardwise sh -c 'STORE=sqlite node build/store-cli/store-cli.js backup --out /data/manual-backup.sqlite'
  ```

- **Backups on the same volume do not protect you from losing the volume or the disk.** Copy them somewhere else regularly. The compose examples put backups on their own volume to make that easy, for example:

  ```bash
  docker compose cp hoardwise:/data/backups ./budget-backups
  ```

- **Restore** replaces ALL current data with the backup. Take a fresh backup first with the command above if there is anything you might want back. Then, with the app stopped, run the copy as the app user so ownership stays correct (replace the file name with one from `/data/backups`):

  ```bash
  docker compose stop
  docker compose run --rm --no-deps --entrypoint sh hoardwise -c 'rm -f /data/hoardwise.sqlite-wal /data/hoardwise.sqlite-shm && cp /data/backups/hoardwise-YYYYMMDD-HHMMSS.sqlite /data/hoardwise.sqlite'
  docker compose up -d
  ```

  For a backup that is on the host (copied off earlier), stream it in as the app user. `-T` turns off the pseudo-terminal, which is needed because stdin is redirected from a file; `umask 077` keeps the copy owner-only:

  ```bash
  docker compose stop
  docker compose run --rm --no-deps -T --entrypoint sh hoardwise -c 'rm -f /data/hoardwise.sqlite-wal /data/hoardwise.sqlite-shm; umask 077; cat > /data/hoardwise.sqlite' < ./budget-backup.sqlite
  docker compose up -d
  ```

  A file brought in with `docker cp` is owned by root, which the app cannot write; if you used it, fix the owner with `docker compose run --rm --no-deps -u 0 --entrypoint chown hoardwise 10001:10001 /data/hoardwise.sqlite` (or `docker compose exec -u 0 hoardwise chown 10001:10001 /data/hoardwise.sqlite` while it is running).

  A restore also brings back any access token that was revoked after the backup was taken. After restoring, review the token list under Settings > Access tokens, or reset the password, which revokes every token.

### Check your backups are working

After the first start, run `docker compose exec hoardwise ls -l /data/backups`. A file named `hoardwise-YYYYMMDD-HHMMSS.sqlite` (`budget-…` for older backups) should exist, written at start-up. If the directory is empty or `docker compose logs hoardwise` shows "Backup failed", the likely cause is volume ownership (the app runs as uid 10001 and cannot write a root-owned volume). Repair it with:

```bash
docker compose exec -u 0 hoardwise chown -R 10001:10001 /data/backups
```

## Forgot your password

**Without a shell (works on any host).** In your data folder create an empty file named `RESET_PASSWORD` (the host's file manager, or `touch /data/RESET_PASSWORD`), then restart the app. On start-up the app deletes the file, signs everyone out, clears any login lock-out, and prints a `Recovery code: ...` line in the log (also saved as `SETUP_CODE.txt`). Open the app, enter the recovery code and choose a new password; this replaces only the password and signs you in. Your account, email and data are unchanged. There is no email-based reset. If you restart again before finishing, create the file again; the same applies if start-up fails after the file was deleted.

If you create the file before any account exists, the app simply removes it and the first-run setup code appears instead.

If the app cannot delete `RESET_PASSWORD` (for example the folder is read-only) it says so in the log and does **not** open recovery. A directory or symlink with that name is ignored.

**With a shell.** The same effect from the command line:

```bash
docker compose exec hoardwise sh -c 'STORE=sqlite node build/store-cli/store-cli.js reset-password'
```

On an install from before 0.3.0, use `budget.sqlite` in place of `hoardwise.sqlite` in this command if that is the file in your data folder.

It prompts for the new password (never taken from arguments), ends every session and access token and clears any login lock-out.

## Moving your data from AWS

Export and import only touch your own data, never the login records, so the steps are:

1. On a machine with a checkout of the repository, dependencies installed (`yarn install`) and AWS credentials, run `STORE=dynamodb DYNAMODB_TABLE=<table> yarn store-cli export 'auth0|abc' --out hoardwise-export.jsonl` (your Auth0 `sub`). The file is owner-only and holds financial data: keep it private and never commit it.
2. Start the self-hosted instance and finish the first-run setup (create the account with the setup code: the `Setup code:` line in the log, or `SETUP_CODE.txt` in the data folder). The import needs this, because you need the local user id.
3. While signed in, read your local user id from `GET /api/auth/me` (the `userId` field, `local|<uuid>`), for example `fetch('/api/auth/me').then(r => r.json())` in the browser console on the app's own page.
4. Stream the export into the container as the app user (the host file's permissions never change and the copy is owner-only), import it, then remove it. It goes in `/tmp`, not `/data`, so it is never left on the data volume or inside a backup. Add `--replace` to the import only if the account already has data:

   ```bash
   docker compose exec -T hoardwise sh -c 'umask 077; cat > /tmp/hoardwise-export.jsonl' < hoardwise-export.jsonl
   docker compose exec -e STORE=sqlite hoardwise node build/store-cli/store-cli.js import --in /tmp/hoardwise-export.jsonl --as-user 'local|<uuid>'
   docker compose exec hoardwise rm /tmp/hoardwise-export.jsonl
   ```

   On an install from before 0.3.0, use `budget.sqlite` in place of `hoardwise.sqlite` in this command if that is the file in your data folder.

5. Delete the export file on the host too, and never commit it. Push subscriptions are not carried over.

## Security notes

- The login throttle is global: anyone who can reach the login can lock you out for up to 15 minutes. `reset-password` clears it.
- The recovery code and the first-run setup code are the only plaintext credentials ever written to the log or to disk; the file (`SETUP_CODE.txt`) is owner-only and removed when the code is used, at shutdown and at the next start.
- Backups on the same volume are not off-site; see above.
- Personal access tokens (Settings > Access tokens) let scripts and AI assistants use the API. To set up an assistant, see [Use Hoardwise with an AI assistant](../README.md#use-hoardwise-with-an-ai-assistant); the routes are described in [`docs/openapi.yaml`](openapi.yaml), and in the app on the Docs page (Settings > API docs), which needs you to be logged in.
- Run it behind HTTPS (or on a network you trust). See [HTTPS](#https) for what plain HTTP gives up.

## For maintainers: releasing

`git tag v1.2.3 && git push origin v1.2.3` publishes `1.2.3`, `1.2` and `latest`. A push to `main` publishes `edge`. Tags must look like `v1.2.3` (or `v1.2.3-rc1`, which publishes only that tag); other `v*` tags such as `v1` or `v1.2` do not trigger a publish.

The first release is `v0.1.0`. After a new package's first publish, check its visibility in the repository's Packages settings: a new GHCR package may default to private, and it must be public for users to pull it without logging in.

### When the vulnerability scan fails

The Trivy step fails the build on HIGH or CRITICAL findings that have a fix, in the base images or in the bundled Caddy binary. New advisories can turn a previously green `main` red without any code change. The fix is to bump the pinned base-image digests in the `Dockerfile` and rebuild. Current digests:

```sh
curl -s https://hub.docker.com/v2/repositories/library/caddy/tags/2 | jq -r .digest
curl -s https://hub.docker.com/v2/repositories/library/node/tags/24-bookworm-slim | jq -r .digest
```

The runtime stage also runs `apt-get upgrade`, and CI passes a new `DEBIAN_UPDATES_STAMP` build argument on every build so that layer is never served from the build cache; Debian security updates already published are therefore picked up at build time. (Without the stamp a cached layer would keep the packages from before a fix, and the scan would fail on a package that `apt-get upgrade` would have updated.) For a finding that is genuinely not exploitable here, add a justified `.trivyignore` entry and have it reviewed in the PR. Every entry must carry an expiry (`CVE-... exp:YYYY-MM-DD`) and a written justification in a comment, so the gate fails again by itself when the date passes. The file currently holds three Caddy entries (CVE-2026-78667, CVE-2026-78669, CVE-2026-97031) expiring 2026-11-14: remove them when the Caddy digest is bumped to a patched rebuild. The "Weekly image scan" workflow scans the published `latest` and `edge` images every Monday with the same gate and `.trivyignore`, so a new advisory shows up as a red run (and an email) before a release rather than at the next push.
