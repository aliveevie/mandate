# Scaffold only. Wired in Phase 5.
# ---- build ----
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY sdk ./sdk
COPY apps/web ./apps/web
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ibxlab/mandate build \
 && pnpm --filter web build \
 && pnpm --filter server build

# ---- run ----
FROM node:20-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/sdk/dist ./node_modules/@ibxlab/mandate/dist
EXPOSE 8787
CMD ["node", "dist/index.js"]
