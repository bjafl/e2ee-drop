FROM node:20-slim AS base
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY packages/db packages/db
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @e2ee-drop/db generate
RUN pnpm --filter @e2ee-drop/api build

FROM node:20-slim
WORKDIR /repo
RUN corepack enable
COPY --from=base /repo /repo
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["pnpm", "start"]
