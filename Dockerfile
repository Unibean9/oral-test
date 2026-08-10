# syntax=docker/dockerfile:1

# --- Stage 1: install deps + compile TypeScript -----------------------------
FROM node:20.20.2-slim AS build
WORKDIR /app

# better-sqlite3 is a native addon; node-gyp needs a toolchain to build it from
# source when no prebuilt binary matches this base image's glibc/Node ABI.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run compile

# --- Stage 2: runtime ---------------------------------------------------------
FROM node:20.20.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Container isolation (no published port beyond what compose exposes, internal
# Docker network) is what keeps this loopback-only-by-design service off the
# public internet — see the comment on HOST in src/app.ts. 0.0.0.0 here just
# lets it be reached AT ALL from outside its own network namespace.
ENV HOST=0.0.0.0

# better-sqlite3's compiled addon links against the runtime's libc/libstdc++;
# rebuilding node_modules from package.json in this stage (instead of copying
# the build stage's node_modules) keeps the image from depending on the
# build-stage toolchain persisting into runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime dependency: src/claude-cli/spawn.ts shells out to the `claude` binary.
# NOT installed here — it's bind-mounted at container start from the VPS's own
# `npm install -g @anthropic-ai/claude-code` install (/usr/local/bin/claude +
# /usr/local/lib/node_modules/@anthropic-ai/claude-code), so the host's login
# session/credential state is reused instead of duplicating the CLI (and its
# auth) inside the image. See docker/docker-compose.prod.yml and
# docker/README.md.

COPY --from=build /app/out ./out

RUN groupadd --system app && useradd --system --gid app --home /app app \
    && mkdir -p /app/data && chown -R app:app /app
USER app

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fs http://127.0.0.1:3001/health || exit 1

CMD ["node", "out/server.js"]
