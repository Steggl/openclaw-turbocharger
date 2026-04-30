# syntax=docker/dockerfile:1.7

# ---------- builder ----------
# Builds the dist/ output. Includes devDependencies for tsup and the
# TypeScript declaration generator. Pruned to production-only deps at
# the end so the runtime stage can copy a slim node_modules tree.
FROM node:22-alpine AS builder

WORKDIR /build

# pnpm is bundled with Node 22 via corepack. Pin to the same version as
# the host workflow to keep behaviour reproducible across environments.
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

# Manifest first so npm-install layer caches independently of source.
COPY package.json pnpm-lock.yaml ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# Build inputs.
COPY tsconfig.json tsconfig.build.json tsup.config.ts ./
COPY src ./src

RUN pnpm build

# Drop devDependencies before the runtime stage copies node_modules.
RUN pnpm prune --prod


# ---------- runtime ----------
# Minimal stage with just the production deps and the built artifact.
# Runs as the non-root `node` user (uid 1000) bundled with the
# node:22-alpine image.
FROM node:22-alpine AS runtime

WORKDIR /app

USER node

COPY --from=builder --chown=node:node /build/node_modules ./node_modules
COPY --from=builder --chown=node:node /build/dist ./dist
COPY --from=builder --chown=node:node /build/package.json ./package.json

# The sidecar listens on port 11435 by default. Override via the
# corresponding TURBOCHARGER_* environment variable.
EXPOSE 11435

# OCI image labels. Version is intentionally not hardcoded — set it
# at build time with --label org.opencontainers.image.version=X.Y.Z
# during the release build (see docs/RELEASING.md).
LABEL org.opencontainers.image.title="openclaw-turbocharger"
LABEL org.opencontainers.image.description="Reactive model escalation sidecar for OpenClaw and any OpenAI-compatible client"
LABEL org.opencontainers.image.source="https://github.com/Steggl/openclaw-turbocharger"
LABEL org.opencontainers.image.licenses="MIT"

# Direct invocation. Override with TURBOCHARGER_* env vars or by
# passing additional args to `docker run`.
ENTRYPOINT ["node", "dist/server.js"]
