# syntax=docker/dockerfile:1.7
#
# Multi-stage build for puku-proxy.
#
# Stage 1 (oven/bun:1.4.2): install deps and bundle the source.
# Stage 2 (oven/bun:1.4.2-slim): runtime image with puku-cli installed via
# bun (not npm — the oven/bun image ships no npm/node). puku-cli is a pure
# ESM script with a `#!/usr/bin/env node` shebang; we rewrite that to `bun`
# in-place and skip puku-cli's Node-only heap re-exec via
# PUKU_CLI_DISABLE_HEAP_RELAUNCH=1. Image stays slim (~80MB).
#
# We use `bun build --target=bun` rather than `--compile` because puku-agent-sdk
# pulls in @sentry/bun, which is a real Node package — compile-time bundling
# occasionally mishandles such peers, and we want a known-good runtime.

ARG BUN_VERSION=1.4.2
# CACHEBUST 2026-09-22T15:05Z — bump this comment to invalidate BuildKit layer
# cache for the runtime stage after the runtime base image changes. Without
# this, Dokploy's buildkit can replay a cached layer that succeeded/failed with
# the previous base image. The comment itself isn't executed; it just makes
# the file change so the cache key changes.
ARG CACHEBUST=run-2026-09-22T15-05Z

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
FROM oven/bun:${BUN_VERSION}-slim AS runtime

# Re-declare CACHEBUST inside this stage (global ARGs go out of scope after
# each FROM). The value is forwarded via `--build-arg CACHEBUST=...` from
# compose.yml, or defaults to the dated sentinel baked in at line 21.
ARG CACHEBUST=run-2026-09-22T15-05Z

# Force a layer cache miss for everything below by referencing CACHEBUST.
# The empty echo runs once and changes the layer hash. Bump the value of
# CACHEBUST (in compose.yml's `args:` block, or in the default above) to
# invalidate downstream layers after a runtime base image change.
RUN echo "puku-proxy runtime cachebust: ${CACHEBUST}"

# puku-cli is the upstream CLI spawned by puku-agent-sdk. It ships as a
# Node script (`#!/usr/bin/env node`) but uses only Node APIs that Bun
# implements (fs/path/url/child_process). Install via `bun add -g` (npm
# isn't available in oven/bun images), rewrite the shebang to bun, and
# disable puku-cli's Node-only heap re-exec.
#
# Run as `bun` user so the global bin dir (default $HOME/.bun/bin) lands
# in the same user's home — and stay as `bun` for the rest of the image.
ENV PUKU_CLI_DISABLE_HEAP_RELAUNCH=1

USER bun
ENV HOME=/home/bun
RUN bun add -g @puku/puku-cli@1.8.56 \
    && CLI="$HOME/.bun/bin/puku-cli" \
    && sed -i '1s|.*|#!/usr/bin/env bun|' "$CLI" \
    && head -1 "$CLI" \
    && "$CLI" --version

WORKDIR /app

# Copy bundled source + production node_modules from the build stage, owned
# by the `bun` user so subsequent USER bun can write here if needed.
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json ./

# ~/.bun/bin is on PATH for the bun user — confirmed by `head -1` above
# resolving the rewritten shebang to bun.
ENV NODE_ENV=production \
    PORT=8787 \
    PATH="/home/bun/.bun/bin:${PATH}"

EXPOSE 8787

# Healthcheck is defined in compose.yml so it stays close to the deploy config.
# Container-level default: just confirm the process is alive.
CMD ["bun", "dist/server.js"]