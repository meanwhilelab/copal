FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS console
WORKDIR /console
COPY console/package.json console/package-lock.json ./
RUN npm ci
COPY console/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=console /console/dist ./console/dist
COPY drizzle ./drizzle
COPY package.json ./
# node:22-alpine bundles an npm whose own dependencies carry CVE-2026-59873
# (tar, CRITICAL) plus HIGHs in undici and brace-expansion. They live under
# /usr/local/lib/node_modules/npm/, not in this app's tree, so a rebuild
# reproduces them — only upgrading npm clears them. Must precede USER node,
# since a global install needs root.
RUN npm i -g npm@latest && npm cache clean --force
# Drop privileges: the runtime never needs root (the `node` user ships in the image).
USER node
# Liveness for the orchestrator (compose healthcheck consumes /healthz).
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Apply migrations (idempotent), then serve.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
