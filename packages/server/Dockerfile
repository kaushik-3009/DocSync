# syntax=docker/dockerfile:1.7
# Multi-stage build: compile and bundle with dev dependencies, then ship only
# the bundle, production node_modules and the RDS CA bundle on a slim base.

FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --filter @collab/server...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @collab/server build

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod --filter @collab/server...

# AWS RDS CA bundle so the gateway can verify TLS to RDS.
FROM alpine:3.20 AS rds-ca
RUN wget -qO /rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem
WORKDIR /app
COPY --from=rds-ca /rds-global-bundle.pem ./rds-global-bundle.pem
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY packages/server/package.json ./packages/server/package.json
USER node
WORKDIR /app/packages/server
EXPOSE 1234
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:${PORT:-1234}/health >/dev/null || exit 1
# The gateway handles SIGTERM itself (graceful drain). ECS adds an init
# process via initProcessEnabled; locally use `docker run --init`.
# The external BullMQ worker uses the same image: `node dist/worker.js`.
CMD ["node", "--enable-source-maps", "dist/index.js"]
