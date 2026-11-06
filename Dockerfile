# Pinned by multi-arch index digest. node:24-bookworm-slim and caddy:2, resolved 2026-10-15 (caddy bumped 2026-11-06); bump deliberately.
FROM caddy:2@sha256:ce773ec7a742ce15ee6bf2bb5f65882b9e2a4487b10733e6f1484f86e6b5d8bc AS caddy

# Runs on the builder's own architecture: it emits only JavaScript, and under QEMU the prerender step times out.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
# React Router prerenders the SPA shell through a local preview server; in the build container its address family and the client's disagree.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# Placeholder values so the SPA build succeeds. They are never used: the container serves its own /config.json.
ENV VITE_AUTH0_DOMAIN=container.invalid VITE_AUTH0_CLIENT_ID=dummy VITE_AUTH0_AUDIENCE=https://container.invalid/api
# scripts/build-store-cli.cjs calls tsc from PATH (yarn adds node_modules/.bin; a plain node invocation does not).
ENV PATH=/app/node_modules/.bin:$PATH
RUN react-router build \
 && node scripts/build-store-cli.cjs \
 && node scripts/build-container.cjs \
 && rm -f build/client/config.json

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
# CI passes a new value on every build. Without it Docker reuses the cached layer below, and the packages stay as they were before
# a Debian security fix, however recent the fix is.
ARG DEBIAN_UPDATES_STAMP=none
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini libcap2-bin ca-certificates \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*
# Nothing at runtime uses npm, corepack or yarn (the healthcheck and the CLI run plain node), so they are not shipped.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
# The official caddy image carries cap_net_bind_service (+p since v2.11.8) on its binary and COPY keeps it; this line is defence in depth.
# File capabilities only matter where net.ipv4.ip_unprivileged_port_start is above 80 (Docker's default sets it to 0), and are
# ignored under no-new-privileges.
# /data and /data/backups are created here, owned by the app user, so a fresh named volume mounted at either inherits that ownership.
RUN setcap cap_net_bind_service=+ep /usr/bin/caddy \
 && groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid 10001 --home-dir /home/app --create-home app \
 && mkdir -p /data/backups \
 && chown 10001:10001 /data /data/backups
WORKDIR /app
COPY --from=build /app/build/client ./build/client
COPY --from=build /app/build/container ./build/container
COPY --from=build /app/build/store-cli ./build/store-cli

ENV NODE_ENV=production DATA_DIR=/data TZ=UTC
LABEL org.opencontainers.image.source="https://github.com/kingchappers/hoardwise" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.title="Hoardwise"
USER app
VOLUME /data
EXPOSE 80 443 443/udp 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "build/container/container/bin.js"]
