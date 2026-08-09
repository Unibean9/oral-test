FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run compile && cp src/db/schema.sql out/db/schema.sql

FROM node:22-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
RUN npm install --global @anthropic-ai/claude-code \
  && groupadd --gid 10001 oral-test \
  && useradd --uid 10001 --gid oral-test --create-home --home-dir /home/oral-test --shell /usr/sbin/nologin oral-test
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/out ./out
COPY runtimes ./runtimes
USER oral-test
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 CMD node -e "fetch('http://127.0.0.1:3001/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "out/server.js"]

FROM dependencies AS seed
WORKDIR /app
RUN apt-get update \
  && apt-get install --yes --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 oral-test \
  && useradd --uid 10001 --gid oral-test --create-home --home-dir /home/oral-test --shell /usr/sbin/nologin oral-test
COPY tsconfig.json tsconfig.scripts.json ./
COPY src ./src
COPY scripts ./scripts
COPY assets ./assets
RUN mkdir /data && chown oral-test:oral-test /data
USER oral-test
CMD ["npm", "run", "ingest:demo", "--", "--pdf-dir", "/app/assets"]
