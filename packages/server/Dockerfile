FROM node:20-alpine AS dependencies

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json

RUN pnpm install --frozen-lockfile

FROM node:20-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
RUN wget -qO /app/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=dependencies /app/packages/shared/node_modules ./packages/shared/node_modules
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY package.json pnpm-workspace.yaml ./

RUN chown -R node:node /app
USER node

EXPOSE 1234

# Runs the server directly through tsx rather than a separate tsc build
# step: `@collab/shared` resolves to its TS source (see its package.json),
# so a plain `node dist/index.js` would need a second build+resolution
# story for the workspace dependency. tsx sidesteps that for now — Phase 7
# (or a dedicated "harden the build" pass) is the right place to introduce
# a proper multi-stage compiled image if startup time or image size become
# a real constraint.
CMD ["/app/packages/server/node_modules/.bin/tsx", "/app/packages/server/src/index.ts"]
