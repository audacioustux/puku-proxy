# syntax=docker/dockerfile:1.7
#
# Multi-stage build for puku-proxy.
#
# Stage 1 (oven/bun:1.4.2): install deps and bundle the source.
# Stage 2 (oven/bun:1.4.2): runtime image with @puku/puku-cli installed via
# npm, non-root, exposes 8787. We use the full oven/bun image (not -slim)
# because puku-cli is installed via npm and the slim variant doesn't ship
# npm.
#
# We use `bun build --target=bun` rather than `--compile` because puku-agent-sdk
# pulls in @sentry/bun, which is a real Node package — compile-time bundling
# occasionally mishandles such peers, and we want a known-good runtime.

ARG BUN_VERSION=1.4.2

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
FROM oven/bun:${BUN_VERSION} AS runtime

# puku-cli is the upstream CLI spawned by puku-agent-sdk. The npm tarball
# contains a wrapper script that depends on @puku/puku-cli being installed
# somewhere on PATH, plus the underlying node bundle. We install it globally
# into /usr/local/bin via npm so the bun runtime image (which carries npm)
# picks it up cleanly.
RUN npm install -g @puku/puku-cli@1.8.56 \
    && which puku-cli \
    && puku-cli --version

WORKDIR /app

# Copy bundled source + production node_modules.
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Run as the built-in non-root `bun` user (uid 1000 in oven/bun images).
USER bun

ENV NODE_ENV=production \
    PORT=8787

EXPOSE 8787

# Healthcheck is defined in compose.yml so it stays close to the deploy config.
# Container-level default: just confirm the process is alive.
CMD ["bun", "dist/server.js"]