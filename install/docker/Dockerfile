FROM node:25-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages packages
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY apps apps
ENV VPG_ADAPTER=node
RUN pnpm --filter @vegastack/pages-web build

FROM node:25-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV VPG_ADAPTER=node
ENV VPG_DB_MIGRATIONS_DIR=/app/migrations
COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/packages/db/migrations ./migrations
EXPOSE 4321
CMD ["node", "dist/server/entry.mjs"]
