FROM node:20-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/server packages/server

EXPOSE 1234

# Runs the server directly through tsx rather than a separate tsc build
# step: `@collab/shared` resolves to its TS source (see its package.json),
# so a plain `node dist/index.js` would need a second build+resolution
# story for the workspace dependency. tsx sidesteps that for now — Phase 7
# (or a dedicated "harden the build" pass) is the right place to introduce
# a proper multi-stage compiled image if startup time or image size become
# a real constraint.
CMD ["npx", "tsx", "packages/server/src/index.ts"]
