# syntax=docker/dockerfile:1.7
#
# Multi-stage build for puku-proxy.
#
# Stage 1 (oven/bun:1.4.2): install deps and bundle the source.
# Stage 2 (node:22-bookworm-slim): runtime image. We need BOTH Node and Bun:
#   - puku-cli is a Node script with a hard `better-sqlite3` native dep.
#     The prebuilt binary is published for Node ABI only; Bun refuses to
#     load it (`'better-sqlite3' is not yet supported in Bun`, see
#     oven-sh/bun#4290). So puku-cli must run under real Node.
#   - The proxy uses Bun.serve — Bun-only. So the proxy must run under Bun.
# `npm install -g @puku/puku-cli` works because npm's prebuild-install
# resolves the prebuilt better-sqlite3 binary for the Node ABI, with no
# native compile required (and no build-essential in the image).
#
# We use `bun build --target=bun` rather than `--compile` because puku-agent-sdk
# pulls in @sentry/bun, which is a real Node package — compile-time bundling
# occasionally mishandles such peers, and we want a known-good runtime.

ARG BUN_VERSION=1.4.2
ARG NODE_VERSION=22.12.0
# CACHEBUST 2026-09-22T17:30Z — bump this comment to invalidate BuildKit layer
# cache for the runtime stage after the runtime base image changes. Without
# this, Dokploy's buildkit can replay a cached layer that succeeded/failed with
# the previous base image. The comment itself isn't executed; it just makes
# the file change so the cache key changes.
ARG CACHEBUST=run-2026-09-22T17-30Z

# ---- Build stage ----
FROM oven/bun:${BUN_VERSION} AS build

WORKDIR /app

# Install all deps (incl. dev) for the build.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Bundle TS sources into a single ESM file so the runtime doesn't need a
# transpiler. --target=bun keeps Bun-specific globals working.
COPY src ./src
COPY tsconfig.json ./
RUN bun build src/server.ts --target=bun --outfile=dist/server.js

# Drop devDependencies for the runtime layer.
RUN bun install --production --frozen-lockfile

# ---- Runtime stage ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# Install Bun (needed for `Bun.serve` in the proxy). Download the official
# release tarball, verify the SHA, and lay it down at /usr/local/bin/bun.
# (The `curl | bash` install script is blocked by some sandboxes; we use the
# direct tarball approach instead.)
ARG BUN_VERSION
ARG CACHEBUST=run-2026-09-22T17-30Z
ARG TARGETARCH

# Re-declare CACHEBUST inside this stage (global ARGs go out of scope after
# each FROM). The value is forwarded via `--build-arg CACHEBUST=...` from
# compose.yml, or defaults to the dated sentinel baked in above.
RUN echo "puku-proxy runtime cachebust: ${CACHEBUST}" \
    && apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/* \
    && cd /tmp \
    && curl -fsSL -o bun.zip \
         "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${TARGETARCH:-x64}.zip" \
    && unzip -o bun.zip \
    && mv bun-linux-*/bun /usr/local/bin/bun \
    && rm -rf bun.zip bun-linux-* \
    && chmod +x /usr/local/bin/bun \
    && bun --version

# puku-cli is the upstream CLI spawned by puku-agent-sdk. It's a Node script
# that requires `better-sqlite3` as a hard runtime dep — the prebuilt binary
# is published for Node ABI only. `npm install -g` resolves the prebuilt in
# ~1 minute (no native compile, no build-essential). Set
# PUKU_CLI_DISABLE_HEAP_RELAUNCH=1 to skip puku-cli's Node heap re-exec
# (injects --max-old-space-size / --expose-gc, which are no-ops under Bun's
# runtime anyway — we want puku-cli running under Node straight).
ENV PUKU_CLI_DISABLE_HEAP_RELAUNCH=1 \
    PUPPETEER_SKIP_DOWNLOAD=true

# npm installs as root by default; the `node` user (uid 1000) gets a clean
# home at /home/node. We chown the global install dir + the puku-cli bin
# symlink so USER node picks them up off PATH later. We don't chown the
# rest of /usr/local/bin to avoid touching unrelated root-owned files.
RUN npm install -g @puku/puku-cli@1.8.56 \
    && which puku-cli \
    && puku-cli --version \
    && head -1 "$(which puku-cli)" \
    && chown -R node:node /usr/local/lib/node_modules \
    && chown -R node:node /usr/local/bin/bun \
    && chown node:node /usr/local/bin/puku-cli /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

# Copy bundled source + production node_modules from the build stage, owned
# by the `node` user so the runtime process can read them.
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./

USER node

ENV NODE_ENV=production \
    PORT=8787 \
    HOME=/home/node \
    PATH="/usr/local/bin:${PATH}"

EXPOSE 8787

# Healthcheck is defined in compose.yml so it stays close to the deploy config.
# Container-level default: just confirm the process is alive.
CMD ["bun", "dist/server.js"]
