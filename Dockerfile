# Mandate reference app: single image, builds the SDK + Vite UI, runs the bundled Express server.
# ---- build ----
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY sdk ./sdk
COPY apps/web ./apps/web
COPY apps/server ./apps/server
# indexer is a workspace member: its real manifest keeps the frozen lockfile valid; --filter skips installing it
COPY indexer/package.json ./indexer/package.json
RUN pnpm install --frozen-lockfile --filter @ibxlab/mandate --filter web --filter server
RUN pnpm --filter @ibxlab/mandate build \
 && pnpm --filter web build \
 && pnpm --filter server build

# ---- run ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 PUBLIC_DIR=./public
# The server is bundled with all dependencies inlined, so no node_modules is needed at runtime.
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./public
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/index.js"]
