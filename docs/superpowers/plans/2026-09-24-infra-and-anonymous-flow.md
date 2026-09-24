# Infra + Anonymous Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are grouped into **Waves**; all tasks within a wave are mutually independent given the outputs of earlier waves and MAY be dispatched to parallel subagents. Do not start a task before every task in an earlier wave it depends on (see each task's **Interfaces: Consumes**) has been completed and reviewed.

**Goal:** Stand up the `e2ee-drop` monorepo, Docker Compose stack (Postgres + MinIO + Fastify API + nginx/React web + migrate + cleanup jobs), and a fully working anonymous, no-login, end-to-end encrypted one-time file drop — functionally replacing the original Netlify+B2 app on self-hosted infrastructure. No user accounts, contacts, permanent links, or SSE in this plan (later plans add those on top of this foundation).

**Architecture:** pnpm monorepo (`packages/db`, `packages/shared`, `apps/api`, `apps/api`, `apps/web`) building two Docker images (`api`, `web`) run via Docker Compose alongside `postgres` and `minio`, plus two one-shot/long-running variants of the `api` image (`migrate`, `cleanup`). Files never pass through the API — the browser uploads/downloads directly to/from MinIO via presigned URLs the API issues.

**Tech Stack:** TypeScript throughout. Backend: Node.js, Fastify, Prisma, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (MinIO is S3-compatible), `nanoid`. Frontend: Vite, React 19, `tweetnacl`/`tweetnacl-util`, shadcn/ui (Radix + Tailwind), `react-i18next`, `react-router-dom`. Infra: Docker Compose, nginx (static + reverse proxy), Postgres, MinIO.

**Spec:** `docs/superpowers/specs/2026-09-24-e2ee-drop-rewrite-design.md`

## Global Constraints

- Backend is Node.js + Fastify + Prisma (spec §9.1/§4).
- Frontend is Vite + React + TypeScript + shadcn/ui (spec §9.1).
- MinIO via presigned PUT/GET URLs, 10-minute expiry — the API never proxies file bytes (spec §8).
- Postgres is the only database in this plan; schema managed by Prisma (spec §5, §9.1).
- Monorepo layout is exactly `packages/db`, `packages/shared`, `apps/web`, `apps/api` (spec §9.1).
- Docker Compose services: `web` (nginx serving the static build, reverse-proxying `/api/*` to `api`), `api`, `postgres`, `minio`, `migrate` (one-shot `prisma migrate deploy`), `cleanup` (interval retention sweep) — all four non-DB/storage services build from the `api`/`web` images with different `command`s where applicable (spec §9.2).
- The server never sees plaintext file bytes or private keys; crypto (NaCl box, `tweetnacl`) runs client-side only (spec §2).
- `Drop.message` is optional, capped at ~500 characters, and is plain (unencrypted) data — the UI must show an explicit "not encrypted" notice next to it (spec §6.1).
- Every `Link` carries a deterministic 3-5 word verification codeword phrase derived server-side from its `recipientPublicKey` (SHA-256, 8 bits/word, 256-word list per locale) — same key and locale always produce the same words, shown to both sender and recipient as an out-of-band check (spec §2.1).
- Anonymous (ownerless) links must show a plain "Anonymous recipient" indicator to the sender — never an invented name/email (spec §6.1).
- `react-i18next` with `en` and `nb` locales is required from the start (spec §11); this plan uses per-feature i18next namespaces so parallel tasks touch separate locale files.
- No bundled reverse proxy/TLS beyond the `web` nginx container; operators front it themselves (spec §9.2).

## Review Focus

- Requesting an upload URL or download URL for an **expired** one-time link must return a clear 404/410, not silently succeed or hand out a URL for a link that should already be gone — covered in Task 10 and Task 11.
- A file whose declared size exceeds `MAX_FILE_SIZE_BYTES` must be rejected with 413 before any presigned URL is issued — covered in Task 10.
- A recipient must not be able to fetch a download URL for a `Drop` that hasn't finished uploading (`status !== "uploaded"`) — the original app never had this race, but the queue-shaped schema makes it possible here; covered in Task 11.
- A one-time `Link` must only ever accept one active `Drop`; a second `upload-url` request while a `Drop` already exists for that link must be rejected, not silently create an orphaned second object in MinIO (this exact class of bug — concurrent writes clobbering session state — is why the original app's last few commits existed; see `e2ee-file-drop` git history) — covered in Task 10.
- `Drop.message` must be length-capped and stripped of control characters **server-side**, not just via the client's `maxlength` attribute, since the API is the real trust boundary — covered in Task 10.

---

## Wave 0 — Monorepo foundation (sequential, must land before any other task starts)

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.nvmrc`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a pnpm workspace where `packages/*` and `apps/*` are recognized workspace members; a shared `tsconfig.base.json` other packages extend via `"extends": "../../tsconfig.base.json"`.

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "e2ee-drop",
  "private": true,
  "version": "0.0.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev:api": "pnpm --filter @e2ee-drop/api dev",
    "dev:web": "pnpm --filter @e2ee-drop/web dev",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint"
  },
  "devDependencies": {
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
.DS_Store
```

- [ ] **Step 5: Create `.nvmrc`**

```
20
```

- [ ] **Step 6: Install pnpm workspace root**

Run: `pnpm install`
Expected: completes with no packages yet (workspace has no members), creates `pnpm-lock.yaml`.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .nvmrc pnpm-lock.yaml
git commit -m "chore: scaffold pnpm monorepo"
```

---

## Wave 1 — Parallel foundation packages (all depend only on Task 1)

### Task 2: `packages/db` — Prisma schema and client

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/prisma/schema.prisma`
- Create: `packages/db/src/index.ts`
- Test: `packages/db/src/index.test.ts`

**Interfaces:**
- Consumes: nothing beyond the workspace root (Task 1).
- Produces: `import { prisma } from "@e2ee-drop/db"` — a singleton `PrismaClient`; and the generated Prisma types `Link`, `Drop` importable from `@e2ee-drop/db` for use by `apps/api`.

- [ ] **Step 1: Create `packages/db/package.json`**

```json
{
  "name": "@e2ee-drop/db",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "generate": "prisma generate",
    "migrate:dev": "prisma migrate dev",
    "migrate:deploy": "prisma migrate deploy",
    "test": "vitest run"
  },
  "dependencies": {
    "@prisma/client": "^6.1.0"
  },
  "devDependencies": {
    "prisma": "^6.1.0",
    "vitest": "^2.1.8",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 2: Create `packages/db/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the Prisma schema**

```prisma
// packages/db/prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Link {
  id                 String    @id @default(cuid())
  ownerId            String?
  slug               String
  mode               String
  visibility         String    @default("public")
  recipientPublicKey String
  codewordLocale     String    @default("en")
  retentionDays      Int?
  isDefault          Boolean   @default(false)
  createdAt          DateTime  @default(now())
  expiresAt          DateTime?
  revokedAt          DateTime?
  drops              Drop[]

  @@unique([ownerId, slug])
  @@index([slug])
}

model Drop {
  id              String   @id @default(cuid())
  linkId          String
  link            Link     @relation(fields: [linkId], references: [id], onDelete: Cascade)
  senderPublicKey String
  senderUserId    String?
  s3Key           String
  nonce           String
  fileName        String
  fileSize        Int
  mimeType        String
  contentMD5      String
  message         String?
  status          String   @default("uploading")
  createdAt       DateTime @default(now())

  @@index([linkId])
}
```

- [ ] **Step 4: Write the Prisma client singleton**

```typescript
// packages/db/src/index.ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { Link, Drop } from "@prisma/client";
```

- [ ] **Step 5: Write a smoke test**

```typescript
// packages/db/src/index.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "./index";

describe("prisma client", () => {
  it("exposes link and drop delegates", () => {
    expect(prisma.link).toBeDefined();
    expect(prisma.drop).toBeDefined();
  });
});
```

- [ ] **Step 6: Install deps, generate client, run test**

Run: `pnpm install && pnpm --filter @e2ee-drop/db generate && pnpm --filter @e2ee-drop/db test`
Expected: Prisma client generates successfully, test PASSes (no live DB needed for this smoke test — it only checks the delegate objects exist on the generated client).

- [ ] **Step 7: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): add Prisma schema for Link/Drop and client singleton"
```

### Task 3: `packages/shared` — shared TypeScript contracts

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/api.ts`
- Create: `packages/shared/src/crypto.ts`
- Create: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing beyond the workspace root (Task 1).
- Produces (imported as `@e2ee-drop/shared` by both `apps/api` and `apps/web`):
  - Types: `LinkMode`, `LinkVisibility`, `DropStatus`
  - `CreateLinkRequest { recipientPublicKey: string; locale?: string }`
  - `CreateLinkResponse { linkId: string; slug: string; codewords: string[] }`
  - `DropSummary { id: string; status: DropStatus; senderPublicKey: string; nonce: string; fileName: string; fileSize: number; mimeType: string; contentMD5: string; message: string | null }`
  - `LinkStatusResponse { slug: string; mode: LinkMode; recipientPublicKey: string; drop: DropSummary | null; isAnonymous: boolean; codewords: string[] }`
  - `RequestUploadUrlRequest { senderPublicKey: string; message?: string; metadata: { fileName: string; fileSize: number; nonce: string; mimeType: string; contentMD5: string } }`
  - `RequestUploadUrlResponse { dropId: string; uploadUrl: string }`
  - `DownloadUrlResponse { downloadUrl: string; fileName: string; fileSize: number; mimeType: string; nonce: string; senderPublicKey: string; contentMD5: string }`
  - `ApiErrorResponse { error: string }`
  - `EncryptedFilePayload { encrypted: Uint8Array; nonce: Uint8Array; originalSize: number }`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@e2ee-drop/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "devDependencies": { "typescript": "^5.9.3" }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `packages/shared/src/api.ts`**

```typescript
// packages/shared/src/api.ts
export type LinkMode = "permanent" | "one-time";
export type LinkVisibility = "public" | "contacts-only";
export type DropStatus = "uploading" | "uploaded" | "downloading" | "downloaded";

export interface CreateLinkRequest {
  recipientPublicKey: string; // base64
  locale?: string; // "en" | "nb" — UI language of the link creator, fixes the codeword wordlist for this link
}

export interface CreateLinkResponse {
  linkId: string;
  slug: string;
  codewords: string[]; // returned immediately so the creator doesn't need a second round-trip to see their phrase
}

export interface DropSummary {
  id: string;
  status: DropStatus;
  senderPublicKey: string; // base64
  nonce: string; // base64
  fileName: string;
  fileSize: number;
  mimeType: string;
  contentMD5: string; // base64
  message: string | null;
}

export interface LinkStatusResponse {
  slug: string;
  mode: LinkMode;
  recipientPublicKey: string; // base64
  drop: DropSummary | null;
  isAnonymous: boolean;
  codewords: string[]; // deterministic verification phrase, up to CODEWORD_MAX_COUNT words, in the link's fixed locale
}

export interface RequestUploadUrlRequest {
  senderPublicKey: string; // base64
  message?: string;
  metadata: {
    fileName: string;
    fileSize: number;
    nonce: string; // base64
    mimeType: string;
    contentMD5: string; // base64
  };
}

export interface RequestUploadUrlResponse {
  dropId: string;
  uploadUrl: string;
}

export interface DownloadUrlResponse {
  downloadUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  nonce: string; // base64
  senderPublicKey: string; // base64
  contentMD5: string; // base64
}

export interface ApiErrorResponse {
  error: string;
}
```

- [ ] **Step 4: Write `packages/shared/src/crypto.ts`**

```typescript
// packages/shared/src/crypto.ts
export interface EncryptedFilePayload {
  encrypted: Uint8Array;
  nonce: Uint8Array;
  originalSize: number;
}

export interface EncryptFileInput {
  unencrypted: Uint8Array;
  recipientPublicKey: Uint8Array;
  senderSecretKey: Uint8Array;
}

export interface DecryptFileInput {
  encrypted: Uint8Array;
  nonce: Uint8Array;
  senderPublicKey: Uint8Array;
  recipientSecretKey: Uint8Array;
}
```

- [ ] **Step 5: Write `packages/shared/src/index.ts`**

```typescript
// packages/shared/src/index.ts
export * from "./api";
export * from "./crypto";
```

- [ ] **Step 6: Type-check the package**

Run: `pnpm install && pnpm --filter @e2ee-drop/shared exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): add shared API and crypto payload types"
```

### Task 4: `apps/api` scaffold — Fastify server, env config, health route, Dockerfile

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/Dockerfile`
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/index.ts`
- Test: `apps/api/src/server.test.ts`

**Interfaces:**
- Consumes: nothing beyond the workspace root (Task 1).
- Produces: `import { env } from "./env"` — a parsed, validated env object with fields `DATABASE_URL: string`, `PORT: number`, `MAX_FILE_SIZE_BYTES: number`, `LINK_EXPIRY_HOURS: number`, `MINIO_ENDPOINT: string`, `MINIO_REGION: string`, `MINIO_BUCKET: string`, `MINIO_ACCESS_KEY: string`, `MINIO_SECRET_KEY: string`, `DROP_RETENTION_DAYS: number`; and `buildServer(): FastifyInstance` from `./server`, which later tasks register routes onto via `server.register(...)` or direct `server.get/post/delete(...)`.

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@e2ee-drop/api",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "cleanup": "tsx src/jobs/cleanup.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@e2ee-drop/db": "workspace:*",
    "@e2ee-drop/shared": "workspace:*",
    "@aws-sdk/client-s3": "^3.908.0",
    "@aws-sdk/s3-request-presigner": "^3.908.0",
    "fastify": "^5.1.0",
    "nanoid": "^5.0.9"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "typescript": "^5.9.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "module": "NodeNext", "moduleResolution": "NodeNext" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `apps/api/src/env.ts`**

```typescript
// apps/api/src/env.ts
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : fallback;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: int("PORT", 3000),
  MAX_FILE_SIZE_BYTES: int("MAX_FILE_SIZE_BYTES", 500 * 1024 * 1024),
  LINK_EXPIRY_HOURS: int("LINK_EXPIRY_HOURS", 24),
  DROP_RETENTION_DAYS: int("DROP_RETENTION_DAYS", 7),
  MINIO_ENDPOINT: required("MINIO_ENDPOINT"),
  MINIO_REGION: process.env.MINIO_REGION ?? "us-east-1",
  MINIO_BUCKET: required("MINIO_BUCKET"),
  MINIO_ACCESS_KEY: required("MINIO_ACCESS_KEY"),
  MINIO_SECRET_KEY: required("MINIO_SECRET_KEY"),
};
```

- [ ] **Step 4: Write `apps/api/src/server.ts`**

```typescript
// apps/api/src/server.ts
import Fastify, { FastifyInstance } from "fastify";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/api/health", async () => ({ status: "ok" }));

  return server;
}
```

- [ ] **Step 5: Write `apps/api/src/index.ts`**

```typescript
// apps/api/src/index.ts
import { buildServer } from "./server";
import { env } from "./env";

const server = buildServer();

server
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .catch((err) => {
    server.log.error(err);
    process.exit(1);
  });
```

- [ ] **Step 6: Write the failing test**

```typescript
// apps/api/src/server.test.ts
import { describe, it, expect } from "vitest";
import { buildServer } from "./server";

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 7: Create `apps/api/Dockerfile`**

```dockerfile
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
```

- [ ] **Step 8: Install deps and run the test (must fail first, since `env.ts` requires vars the test env won't have — expected)**

Run: `pnpm install && DATABASE_URL=postgresql://test PORT=3000 MINIO_ENDPOINT=http://test MINIO_BUCKET=test MINIO_ACCESS_KEY=test MINIO_SECRET_KEY=test pnpm --filter @e2ee-drop/api test`
Expected: PASS (the test only exercises `buildServer`, which does not read `env` — `env.ts` is loaded by `index.ts`, not `server.ts`, intentionally, so `server.ts` stays testable without a full env).

- [ ] **Step 9: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): scaffold Fastify server with health route and Dockerfile"
```

### Task 5: `apps/web` scaffold — Vite + React + TS + Tailwind + shadcn + i18n, Dockerfile + nginx

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`, `apps/web/tsconfig.app.json`, `apps/web/tsconfig.node.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/components.json`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/index.css`
- Create: `apps/web/src/i18n.ts`
- Create: `apps/web/src/locales/en/common.json`, `apps/web/src/locales/nb/common.json`
- Create: `apps/web/Dockerfile`, `apps/web/nginx.conf`

**Interfaces:**
- Consumes: nothing beyond the workspace root (Task 1).
- Produces: a running Vite dev server and production build; `i18n` initialized with namespace `"common"` pre-loaded — later tasks add their own namespaces (e.g. `"createLink"`, `"upload"`, `"download"`) as separate JSON files under `src/locales/{en,nb}/<namespace>.json` and call `useTranslation("<namespace>")`, so concurrent edits never touch the same locale file; shadcn components generated under `src/components/ui/` via the shadcn CLI, consumed by later component tasks as `import { Button } from "@/components/ui/button"` etc.

- [ ] **Step 1: Scaffold the Vite React-TS app**

Run (from `apps/web`, after `mkdir -p apps/web && cd apps/web`):
`pnpm create vite@latest . -- --template react-ts`

- [ ] **Step 2: Rename the package and add workspace deps**

Edit `apps/web/package.json` — set `"name": "@e2ee-drop/web"`, add to `dependencies`: `"@e2ee-drop/shared": "workspace:*"`, `"tweetnacl": "^1.0.3"`, `"tweetnacl-util": "^0.15.1"`, `"react-router-dom": "^7.9.4"`, `"react-i18next": "^16.0.1"`, `"i18next": "^24.2.0"`, `"i18next-browser-languagedetector": "^8.2.0"`; add `"vitest": "^2.1.8"`, `"@testing-library/react": "^16.1.0"`, `"@testing-library/jest-dom": "^6.6.3"`, and `"jsdom": "^25.0.1"` to `devDependencies`; add a `"test": "vitest run"` script.

- [ ] **Step 3: Install and initialize Tailwind + shadcn**

Run:
```bash
pnpm --filter @e2ee-drop/web add tailwindcss @tailwindcss/vite
pnpm --filter @e2ee-drop/web dlx shadcn@latest init -d
pnpm --filter @e2ee-drop/web dlx shadcn@latest add button card alert progress select
```
Expected: creates `apps/web/components.json`, `apps/web/src/components/ui/{button,card,alert,progress,select}.tsx`, and `apps/web/src/lib/utils.ts` (the `cn()` helper).

- [ ] **Step 4: Wire Tailwind into `apps/web/vite.config.ts`**

```typescript
// apps/web/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
  },
});
```

- [ ] **Step 4b: Create `apps/web/src/setupTests.ts`**

```typescript
// apps/web/src/setupTests.ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 5: Write `apps/web/src/i18n.ts`**

```typescript
// apps/web/src/i18n.ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import commonEn from "./locales/en/common.json";
import commonNb from "./locales/nb/common.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    resources: {
      en: { common: commonEn },
      nb: { common: commonNb },
    },
    interpolation: { escapeValue: false },
  });

export default i18n;
```

- [ ] **Step 6: Write base locale files**

```json
// apps/web/src/locales/en/common.json
{
  "appName": "e2ee-drop",
  "nav": { "receive": "Receive a file", "send": "Send a file" }
}
```

```json
// apps/web/src/locales/nb/common.json
{
  "appName": "e2ee-drop",
  "nav": { "receive": "Motta en fil", "send": "Send en fil" }
}
```

- [ ] **Step 7: Wire `i18n` into `apps/web/src/main.tsx`**

```typescript
// apps/web/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 8: Write a minimal `apps/web/src/App.tsx` placeholder (routes added by Tasks 13-15)**

```tsx
// apps/web/src/App.tsx
import { useTranslation } from "react-i18next";

export default function App() {
  const { t } = useTranslation("common");
  return <div className="p-4">{t("appName")}</div>;
}
```

- [ ] **Step 9: Create `apps/web/Dockerfile`**

```dockerfile
FROM node:20-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @e2ee-drop/web build

FROM nginx:1.27-alpine
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **Step 10: Create `apps/web/nginx.conf`**

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  location /api/ {
    proxy_pass http://api:3000;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
  }

  location / {
    try_files $uri /index.html;
  }
}
```

- [ ] **Step 11: Run the dev build to verify the scaffold compiles**

Run: `pnpm install && pnpm --filter @e2ee-drop/web build`
Expected: builds successfully, `apps/web/dist/index.html` exists.

- [ ] **Step 12: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): scaffold Vite/React/shadcn app with i18n and Dockerfile"
```

### Task 6: `docker-compose.yml` and `.env.example`

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

**Interfaces:**
- Consumes: nothing beyond the workspace root (Task 1) — references the `api`/`web` Dockerfiles from Tasks 4/5 by path but does not need them to be finished to be written (build contexts are declared, not built, until `docker compose up`).
- Produces: the six services referenced by Tasks 9-16 (`web`, `api`, `postgres`, `minio`, `migrate`, `cleanup`) and the full env var contract (`.env.example`) later tasks' code reads from.

- [ ] **Step 1: Write `.env.example`**

```
# Postgres
POSTGRES_USER=e2eedrop
POSTGRES_PASSWORD=change-me
POSTGRES_DB=e2eedrop
DATABASE_URL=postgresql://e2eedrop:change-me@postgres:5432/e2eedrop

# MinIO
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=change-me-too
MINIO_ENDPOINT=http://minio:9000
MINIO_REGION=us-east-1
MINIO_BUCKET=e2ee-drop
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=change-me-too

# API
PORT=3000
MAX_FILE_SIZE_BYTES=524288000
LINK_EXPIRY_HOURS=24
DROP_RETENTION_DAYS=7
```

- [ ] **Step 2: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      timeout: 5s
      retries: 10

  minio:
    image: minio/minio:latest
    command: server /data
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 5s
      retries: 10

  migrate:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    command: ["pnpm", "--filter", "@e2ee-drop/db", "migrate:deploy"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    environment:
      DATABASE_URL: ${DATABASE_URL}
      PORT: ${PORT}
      MAX_FILE_SIZE_BYTES: ${MAX_FILE_SIZE_BYTES}
      LINK_EXPIRY_HOURS: ${LINK_EXPIRY_HOURS}
      DROP_RETENTION_DAYS: ${DROP_RETENTION_DAYS}
      MINIO_ENDPOINT: ${MINIO_ENDPOINT}
      MINIO_REGION: ${MINIO_REGION}
      MINIO_BUCKET: ${MINIO_BUCKET}
      MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY}
      MINIO_SECRET_KEY: ${MINIO_SECRET_KEY}
    depends_on:
      migrate:
        condition: service_completed_successfully
      minio:
        condition: service_healthy

  cleanup:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    command: ["pnpm", "--filter", "@e2ee-drop/api", "cleanup"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      DROP_RETENTION_DAYS: ${DROP_RETENTION_DAYS}
      MINIO_ENDPOINT: ${MINIO_ENDPOINT}
      MINIO_REGION: ${MINIO_REGION}
      MINIO_BUCKET: ${MINIO_BUCKET}
      MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY}
      MINIO_SECRET_KEY: ${MINIO_SECRET_KEY}
    depends_on:
      migrate:
        condition: service_completed_successfully
      minio:
        condition: service_healthy

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    ports:
      - "8080:80"
    depends_on:
      - api

volumes:
  postgres-data:
  minio-data:
```

- [ ] **Step 3: Validate the compose file syntax**

Run: `docker compose config`
Expected: prints the resolved config with no errors (build steps are not executed yet).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add Docker Compose stack and env example"
```

---

## Wave 2 — Backend and frontend building blocks (parallel; each depends on specific Wave 0/1 tasks as noted)

### Task 7: MinIO storage lib

**Files:**
- Create: `apps/api/src/lib/storage.ts`
- Test: `apps/api/src/lib/storage.test.ts`

**Interfaces:**
- Consumes: `env` from `./env` (Task 4).
- Produces: `ensureBucket(): Promise<void>`, `getSignedUploadUrl(s3Key: string, expiresIn?: number): Promise<string>`, `getSignedDownloadUrl(s3Key: string, expiresIn?: number): Promise<string>`, `deleteObject(s3Key: string): Promise<void>` — consumed by Tasks 10, 11, 12.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/storage.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../env", () => ({
  env: {
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_REGION: "us-east-1",
    MINIO_BUCKET: "test-bucket",
    MINIO_ACCESS_KEY: "test",
    MINIO_SECRET_KEY: "test",
  },
}));

import { getSignedUploadUrl, getSignedDownloadUrl } from "./storage";

describe("storage", () => {
  it("produces a presigned PUT url pointing at the configured bucket/key", async () => {
    const url = await getSignedUploadUrl("links/abc/drop1");
    expect(url).toContain("test-bucket");
    expect(url).toContain("links/abc/drop1");
  });

  it("produces a presigned GET url pointing at the configured bucket/key", async () => {
    const url = await getSignedDownloadUrl("links/abc/drop1");
    expect(url).toContain("test-bucket");
    expect(url).toContain("links/abc/drop1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/api test -- storage`
Expected: FAIL — `./storage` module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/lib/storage.ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: env.MINIO_REGION,
      endpoint: env.MINIO_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.MINIO_ACCESS_KEY,
        secretAccessKey: env.MINIO_SECRET_KEY,
      },
    });
  }
  return client;
}

export async function ensureBucket(): Promise<void> {
  const s3 = getClient();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.MINIO_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: env.MINIO_BUCKET }));
  }
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: env.MINIO_BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedMethods: ["GET", "PUT"],
            AllowedOrigins: ["*"],
            AllowedHeaders: ["*"],
          },
        ],
      },
    })
  );
}

export async function getSignedUploadUrl(s3Key: string, expiresIn = 600): Promise<string> {
  const s3 = getClient();
  const command = new PutObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function getSignedDownloadUrl(s3Key: string, expiresIn = 600): Promise<string> {
  const s3 = getClient();
  const command = new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function deleteObject(s3Key: string): Promise<void> {
  const s3 = getClient();
  await s3.send(new DeleteObjectCommand({ Bucket: env.MINIO_BUCKET, Key: s3Key }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/api test -- storage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/storage.ts apps/api/src/lib/storage.test.ts
git commit -m "feat(api): add MinIO presigned URL and bucket-ensure helpers"
```

### Task 8: Crypto lib + Web Worker + `useFileEncryption` hook

**Files:**
- Create: `apps/web/src/lib/cryptoUtils.ts`
- Create: `apps/web/src/workers/crypto.worker.ts`
- Create: `apps/web/src/hooks/useFileEncryption.ts`
- Test: `apps/web/src/lib/cryptoUtils.test.ts`

**Interfaces:**
- Consumes: `EncryptedFilePayload`, `EncryptFileInput`, `DecryptFileInput` from `@e2ee-drop/shared` (Task 3).
- Produces: `encryptFile(input: EncryptFileInput): EncryptedFilePayload`, `decryptFile(input: DecryptFileInput): Uint8Array` from `cryptoUtils.ts`; and `useFileEncryption()` hook exposing `{ keyPair, setKeyPair, encryptFile, decryptFile, isProcessing, progress }`, consumed by Tasks 13-15.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/lib/cryptoUtils.test.ts
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { encryptFile, decryptFile } from "./cryptoUtils";

describe("cryptoUtils", () => {
  it("round-trips a message through encrypt then decrypt", () => {
    const sender = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const message = new TextEncoder().encode("hello e2ee-drop");

    const { encrypted, nonce } = encryptFile({
      unencrypted: message,
      recipientPublicKey: recipient.publicKey,
      senderSecretKey: sender.secretKey,
    });

    const decrypted = decryptFile({
      encrypted,
      nonce,
      senderPublicKey: sender.publicKey,
      recipientSecretKey: recipient.secretKey,
    });

    expect(new TextDecoder().decode(decrypted)).toBe("hello e2ee-drop");
  });

  it("throws when decrypting with the wrong key", () => {
    const sender = nacl.box.keyPair();
    const recipient = nacl.box.keyPair();
    const wrongRecipient = nacl.box.keyPair();
    const message = new TextEncoder().encode("secret");

    const { encrypted, nonce } = encryptFile({
      unencrypted: message,
      recipientPublicKey: recipient.publicKey,
      senderSecretKey: sender.secretKey,
    });

    expect(() =>
      decryptFile({
        encrypted,
        nonce,
        senderPublicKey: sender.publicKey,
        recipientSecretKey: wrongRecipient.secretKey,
      })
    ).toThrow("Decryption failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- cryptoUtils`
Expected: FAIL — `./cryptoUtils` module not found.

- [ ] **Step 3: Write `apps/web/src/lib/cryptoUtils.ts`**

```typescript
// apps/web/src/lib/cryptoUtils.ts
import nacl from "tweetnacl";
import type { EncryptFileInput, DecryptFileInput, EncryptedFilePayload } from "@e2ee-drop/shared";

export function encryptFile({
  unencrypted,
  recipientPublicKey,
  senderSecretKey,
}: EncryptFileInput): EncryptedFilePayload {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(unencrypted, nonce, recipientPublicKey, senderSecretKey);
  return { encrypted, nonce, originalSize: unencrypted.length };
}

export function decryptFile({
  encrypted,
  nonce,
  senderPublicKey,
  recipientSecretKey,
}: DecryptFileInput): Uint8Array {
  const decrypted = nacl.box.open(encrypted, nonce, senderPublicKey, recipientSecretKey);
  if (!decrypted) throw new Error("Decryption failed");
  return decrypted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- cryptoUtils`
Expected: PASS.

- [ ] **Step 5: Write the Web Worker**

```typescript
// apps/web/src/workers/crypto.worker.ts
import { encryptFile, decryptFile } from "../lib/cryptoUtils";

self.onmessage = (e: MessageEvent) => {
  const { type, data } = e.data;
  if (type === "ping") {
    self.postMessage({ type: "pong" });
    return;
  }
  if (type === "encryptFile") {
    const result = encryptFile(data);
    self.postMessage({ type: "fileEncrypted", data: result }, [result.encrypted.buffer]);
    return;
  }
  if (type === "decryptFile") {
    try {
      const decrypted = decryptFile(data);
      self.postMessage({ type: "fileDecrypted", data: { decrypted } }, [decrypted.buffer]);
    } catch (error) {
      self.postMessage({ type: "decryptError", error: String(error) });
    }
  }
};
```

- [ ] **Step 6: Write `apps/web/src/hooks/useFileEncryption.ts`**

```typescript
// apps/web/src/hooks/useFileEncryption.ts
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { useCallback, useEffect, useRef, useState } from "react";
import { encryptFile as encryptFileSyncFn, decryptFile as decryptFileSyncFn } from "@/lib/cryptoUtils";

export interface EncryptedFileResult {
  encrypted: Blob;
  nonce: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  senderPublicKey: string;
  contentMD5: string;
}

export interface DecryptMetadata {
  nonce: string;
  senderPublicKey: string;
  fileName: string;
  mimeType: string;
}

export function useFileEncryption(initialKeyPair?: nacl.BoxKeyPair) {
  const workerRef = useRef<Worker | null>(null);
  const [keyPair, setKeyPair] = useState<nacl.BoxKeyPair | null>(initialKeyPair ?? null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    workerRef.current = new Worker(new URL("../workers/crypto.worker.ts", import.meta.url), {
      type: "module",
    });
    return () => workerRef.current?.terminate();
  }, []);

  const encryptFile = useCallback(
    async (file: File, recipientPublicKey: string): Promise<EncryptedFileResult> => {
      if (!keyPair) throw new Error("No local key pair found");
      setIsProcessing(true);
      setProgress(0);
      try {
        const fileBytes = new Uint8Array(await file.arrayBuffer());
        setProgress(30);
        const { encrypted, nonce, originalSize } = encryptFileSyncFn({
          unencrypted: fileBytes,
          recipientPublicKey: decodeBase64(recipientPublicKey),
          senderSecretKey: keyPair.secretKey,
        });
        setProgress(100);
        const md5Hash = nacl.hash(encrypted);
        return {
          encrypted: new Blob([encrypted], { type: "application/octet-stream" }),
          nonce: encodeBase64(nonce),
          fileName: file.name,
          mimeType: file.type,
          fileSize: originalSize,
          senderPublicKey: encodeBase64(keyPair.publicKey),
          contentMD5: encodeBase64(md5Hash),
        };
      } finally {
        setIsProcessing(false);
      }
    },
    [keyPair]
  );

  const decryptFile = useCallback(
    async (encryptedBlob: Blob, metadata: DecryptMetadata): Promise<File> => {
      if (!keyPair) throw new Error("No local key pair found");
      setIsProcessing(true);
      setProgress(0);
      try {
        const encryptedBytes = new Uint8Array(await encryptedBlob.arrayBuffer());
        setProgress(50);
        const decrypted = decryptFileSyncFn({
          encrypted: encryptedBytes,
          nonce: decodeBase64(metadata.nonce),
          senderPublicKey: decodeBase64(metadata.senderPublicKey),
          recipientSecretKey: keyPair.secretKey,
        });
        setProgress(100);
        return new File([decrypted], metadata.fileName, { type: metadata.mimeType });
      } finally {
        setIsProcessing(false);
      }
    },
    [keyPair]
  );

  return { keyPair, setKeyPair, encryptFile, decryptFile, isProcessing, progress };
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/cryptoUtils.ts apps/web/src/lib/cryptoUtils.test.ts apps/web/src/workers/crypto.worker.ts apps/web/src/hooks/useFileEncryption.ts
git commit -m "feat(web): port NaCl box crypto, worker, and useFileEncryption hook"
```

### Task 9: Links lib + create/get/delete routes

**Files:**
- Create: `apps/api/src/lib/links.ts`
- Create: `apps/api/src/routes/links.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/links.test.ts`

**Interfaces:**
- Consumes: `prisma`, `Link`, `Drop` from `@e2ee-drop/db` (Task 2); `CreateLinkRequest`, `CreateLinkResponse`, `LinkStatusResponse`, `DropSummary` from `@e2ee-drop/shared` (Task 3); `env` from `../env` (Task 4).
- Produces: `createOneTimeLink(recipientPublicKey: string): Promise<Link>`, `getLinkBySlug(slug: string): Promise<(Link & { drops: Drop[] }) | null>`, `isLinkExpired(link: Link): boolean`, `toDropSummary(drop: Drop): DropSummary`, `toLinkStatusResponse(link: Link & { drops: Drop[] }): LinkStatusResponse` from `lib/links.ts` — consumed by Tasks 10 and 11. Registers routes `POST /api/links`, `GET /api/links/:slug`, `DELETE /api/links/:slug` on the Fastify instance from Task 4.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/routes/links.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";
import { registerLinkRoutes } from "./links";

describe("link routes", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("creates a one-time link and can fetch it by slug", async () => {
    const server = buildServer();
    registerLinkRoutes(server);

    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50a2V5" },
    });
    expect(createResponse.statusCode).toBe(200);
    const { slug } = createResponse.json();
    expect(slug).toBeTruthy();

    const getResponse = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(getResponse.statusCode).toBe(200);
    const body = getResponse.json();
    expect(body.recipientPublicKey).toBe("cmVjaXBpZW50a2V5");
    expect(body.isAnonymous).toBe(true);
    expect(body.drop).toBeNull();
  });

  it("returns 404 for an unknown slug", async () => {
    const server = buildServer();
    registerLinkRoutes(server);
    const response = await server.inject({ method: "GET", url: "/api/links/does-not-exist" });
    expect(response.statusCode).toBe(404);
  });

  it("deletes a link", async () => {
    const server = buildServer();
    registerLinkRoutes(server);
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50a2V5" },
    });
    const { slug } = createResponse.json();

    const deleteResponse = await server.inject({ method: "DELETE", url: `/api/links/${slug}` });
    expect(deleteResponse.statusCode).toBe(200);

    const getResponse = await server.inject({ method: "GET", url: `/api/links/${slug}` });
    expect(getResponse.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (this full env var line is reused by every later `apps/api` test task — `env.ts` reads all of it eagerly on import, not just `DATABASE_URL`):
`DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- links`
Expected: FAIL — `./links` route module not found. (Requires `docker compose up -d postgres minio` and `pnpm --filter @e2ee-drop/db migrate:deploy` run once first so the test database has the schema.)

- [ ] **Step 3: Write `apps/api/src/lib/links.ts`**

```typescript
// apps/api/src/lib/links.ts
import { customAlphabet } from "nanoid";
import { prisma, type Link, type Drop } from "@e2ee-drop/db";
import type { DropSummary, LinkStatusResponse } from "@e2ee-drop/shared";
import { env } from "../env";

const nanoid = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 16);

export async function createOneTimeLink(recipientPublicKey: string): Promise<Link> {
  return prisma.link.create({
    data: {
      slug: nanoid(),
      mode: "one-time",
      recipientPublicKey,
      expiresAt: new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000),
    },
  });
}

export async function getLinkBySlug(slug: string): Promise<(Link & { drops: Drop[] }) | null> {
  return prisma.link.findFirst({ where: { slug }, include: { drops: true } });
}

export function isLinkExpired(link: Link): boolean {
  return link.expiresAt !== null && link.expiresAt.getTime() < Date.now();
}

export function toDropSummary(drop: Drop): DropSummary {
  return {
    id: drop.id,
    status: drop.status as DropSummary["status"],
    senderPublicKey: drop.senderPublicKey,
    nonce: drop.nonce,
    fileName: drop.fileName,
    fileSize: drop.fileSize,
    mimeType: drop.mimeType,
    contentMD5: drop.contentMD5,
    message: drop.message,
  };
}

export function toLinkStatusResponse(link: Link & { drops: Drop[] }): LinkStatusResponse {
  const activeDrop = link.drops[0] ?? null;
  return {
    slug: link.slug,
    mode: link.mode as LinkStatusResponse["mode"],
    recipientPublicKey: link.recipientPublicKey,
    drop: activeDrop ? toDropSummary(activeDrop) : null,
    isAnonymous: link.ownerId === null,
  };
}
```

- [ ] **Step 4: Write `apps/api/src/routes/links.ts`**

```typescript
// apps/api/src/routes/links.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { CreateLinkRequest, CreateLinkResponse } from "@e2ee-drop/shared";
import { createOneTimeLink, getLinkBySlug, isLinkExpired, toLinkStatusResponse } from "../lib/links";

export function registerLinkRoutes(server: FastifyInstance): void {
  server.post<{ Body: CreateLinkRequest }>("/api/links", async (request, reply) => {
    const { recipientPublicKey } = request.body;
    if (!recipientPublicKey) {
      return reply.status(400).send({ error: "Missing recipientPublicKey" });
    }
    const link = await createOneTimeLink(recipientPublicKey);
    const body: CreateLinkResponse = { linkId: link.id, slug: link.slug };
    return reply.send(body);
  });

  server.get<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    if (isLinkExpired(link)) {
      await prisma.link.delete({ where: { id: link.id } });
      return reply.status(404).send({ error: "Link not found" });
    }
    return reply.send(toLinkStatusResponse(link));
  });

  server.delete<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    await prisma.link.delete({ where: { id: link.id } });
    return reply.send({ deleted: true });
  });
}
```

- [ ] **Step 5: Register the routes in `apps/api/src/server.ts`**

```typescript
// apps/api/src/server.ts
import Fastify, { FastifyInstance } from "fastify";
import { registerLinkRoutes } from "./routes/links";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/api/health", async () => ({ status: "ok" }));
  registerLinkRoutes(server);

  return server;
}
```

- [ ] **Step 6: Remove the now-redundant `registerLinkRoutes(server)` call from the test file** (routes are registered by `buildServer()` itself now) — edit `apps/api/src/routes/links.test.ts`, delete the three `registerLinkRoutes(server);` lines.

- [ ] **Step 7: Run test to verify it passes**

Run: `docker compose up -d postgres minio && pnpm --filter @e2ee-drop/db migrate:deploy && DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- links`
Expected: PASS (all three tests).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/links.ts apps/api/src/routes/links.ts apps/api/src/routes/links.test.ts apps/api/src/server.ts
git commit -m "feat(api): add link create/get/delete routes"
```

### Task 9b: Link verification codewords

**Files:**
- Create: `apps/api/src/lib/wordlists.ts`
- Create: `apps/api/src/lib/codewords.ts`
- Modify: `apps/api/src/lib/links.ts`
- Modify: `apps/api/src/routes/links.ts`
- Test: `apps/api/src/lib/codewords.test.ts`
- Test (extend): `apps/api/src/routes/links.test.ts`

**Interfaces:**
- Consumes: `CreateLinkRequest`, `LinkStatusResponse` from `@e2ee-drop/shared` (Task 3, already patched with `locale?: string` and `codewords: string[]`); `createOneTimeLink`, `toLinkStatusResponse` from `../lib/links` (Task 9, modified by this task).
- Produces: `CodewordLocale = "en" | "nb"`, `WORDLISTS: Record<CodewordLocale, string[]>`, `DEFAULT_LOCALE: CodewordLocale` from `wordlists.ts`; `CODEWORD_DEFAULT_COUNT`, `CODEWORD_MAX_COUNT`, `resolveLocale(locale?: string): CodewordLocale`, `deriveCodewords(publicKeyBase64: string, locale: CodewordLocale, count?: number): string[]` from `codewords.ts` — consumed by `lib/links.ts` in this same task, and by Task 13 (which needs `CODEWORD_DEFAULT_COUNT`/`CODEWORD_MAX_COUNT` client-side only as display constants duplicated in the frontend, since the derivation itself always runs server-side).

- [ ] **Step 1: Write `apps/api/src/lib/wordlists.ts`**

256 short, common, unambiguous nouns per locale (English and Norwegian Bokmål), one 8-bit hash byte indexes one word (see spec §2.1). Kept in the same order across locales for maintainability, though nothing requires exact translation pairing.

```typescript
// apps/api/src/lib/wordlists.ts
export type CodewordLocale = "en" | "nb";
export const DEFAULT_LOCALE: CodewordLocale = "en";

const EN: string[] = [
  "fox", "wolf", "bear", "deer", "stoat", "lynx", "mole", "mouse", "otter", "badger", "rabbit", "squirrel", "hedgehog", "raccoon", "beaver", "elk",
  "owl", "hawk", "crow", "swan", "duck", "goose", "robin", "sparrow", "eagle", "falcon", "heron", "stork", "magpie", "raven", "dove", "wren",
  "fish", "seal", "whale", "shark", "crab", "clam", "squid", "eel", "trout", "salmon", "perch", "pike", "shrimp", "mussel", "starfish", "jellyfish",
  "ant", "bee", "wasp", "moth", "fly", "beetle", "cricket", "spider", "ladybug", "dragonfly", "grasshopper", "firefly", "snail", "mite", "worm", "mosquito",
  "oak", "pine", "birch", "maple", "elm", "willow", "cedar", "spruce", "fern", "moss", "reed", "thistle", "clover", "ivy", "bamboo", "cactus",
  "apple", "pear", "plum", "peach", "cherry", "grape", "lemon", "orange", "melon", "currant", "fig", "mango", "kiwi", "apricot", "olive", "walnut",
  "carrot", "potato", "onion", "garlic", "cabbage", "leek", "radish", "turnip", "beet", "pumpkin", "celery", "spinach", "lettuce", "parsley", "bean", "yam",
  "bread", "butter", "cheese", "honey", "sugar", "salt", "pepper", "grain", "rice", "oat", "wheat", "syrup", "jam", "broth", "soup", "tea",
  "river", "lake", "ocean", "cloud", "storm", "rain", "snow", "frost", "fog", "wind", "thunder", "rainbow", "valley", "hill", "cliff", "cave",
  "forest", "meadow", "desert", "island", "mountain", "glacier", "canyon", "marsh", "dune", "coast", "star", "moon", "comet", "planet", "dawn", "dusk",
  "chair", "table", "lamp", "mirror", "pillow", "blanket", "carpet", "curtain", "shelf", "drawer", "basket", "candle", "vase", "clock", "broom", "bucket",
  "hammer", "nail", "screw", "wrench", "saw", "drill", "chisel", "ladder", "rope", "anchor", "hook", "blade", "axe", "shovel", "rake", "pliers",
  "scarf", "glove", "hat", "boot", "coat", "jacket", "sock", "belt", "button", "ribbon", "cape", "apron", "mitten", "sandal", "cloak", "veil",
  "finger", "elbow", "ankle", "shoulder", "wrist", "cheek", "chin", "jaw", "wagon", "sled", "canoe", "raft", "barge", "kayak", "ferry", "tram",
  "bridge", "tower", "castle", "cabin", "barn", "mill", "harbor", "market", "chapel", "cottage", "iron", "copper", "silver", "gold", "marble", "clay",
  "key", "lock", "coin", "bell", "flag", "kite", "drum", "flute", "mask", "ring", "crown", "shield", "lantern", "compass", "feather", "pebble",
];

const NB: string[] = [
  "rev", "ulv", "bjørn", "hjort", "røyskatt", "gaupe", "muldvarp", "mus", "oter", "grevling", "kanin", "ekorn", "pinnsvin", "vaskebjørn", "bever", "elg",
  "ugle", "hauk", "kråke", "svane", "and", "gås", "rødstrupe", "spurv", "ørn", "falk", "hegre", "stork", "skjære", "ravn", "due", "gjerdesmett",
  "fisk", "sel", "hval", "hai", "krabbe", "musling", "blekksprut", "ål", "ørret", "laks", "abbor", "gjedde", "reke", "blåskjell", "sjøstjerne", "manet",
  "maur", "bie", "veps", "møll", "flue", "bille", "siriss", "edderkopp", "marihøne", "øyenstikker", "gresshoppe", "sankthansorm", "snegle", "midd", "mark", "mygg",
  "eik", "furu", "bjørk", "lønn", "alm", "pil", "seder", "gran", "bregne", "mose", "siv", "tistel", "kløver", "eføy", "bambus", "kaktus",
  "eple", "pære", "plomme", "fersken", "kirsebær", "drue", "sitron", "appelsin", "melon", "rips", "fiken", "mango", "kiwi", "aprikos", "oliven", "valnøtt",
  "gulrot", "potet", "løk", "hvitløk", "kål", "purre", "reddik", "kålrot", "rødbete", "gresskar", "selleri", "spinat", "salat", "persille", "bønne", "jams",
  "brød", "smør", "ost", "honning", "sukker", "salt", "pepper", "korn", "ris", "havre", "hvete", "sirup", "syltetøy", "kraft", "suppe", "te",
  "elv", "innsjø", "hav", "sky", "storm", "regn", "snø", "frost", "tåke", "vind", "torden", "regnbue", "dal", "ås", "klippe", "hule",
  "skog", "eng", "ørken", "øy", "fjell", "isbre", "kløft", "myr", "sanddyne", "kyst", "stjerne", "måne", "komet", "planet", "morgengry", "skumring",
  "stol", "bord", "lampe", "speil", "pute", "teppe", "matte", "gardin", "hylle", "skuff", "kurv", "lys", "vase", "klokke", "kost", "bøtte",
  "hammer", "spiker", "skrue", "skiftenøkkel", "sag", "drill", "meisel", "stige", "tau", "anker", "krok", "blad", "øks", "spade", "rake", "tang",
  "skjerf", "hanske", "hatt", "støvel", "frakk", "jakke", "sokk", "belte", "knapp", "bånd", "kappe", "forkle", "vott", "sandal", "kåpe", "slør",
  "finger", "albue", "ankel", "skulder", "håndledd", "kinn", "hake", "kjeve", "vogn", "kjelke", "kano", "flåte", "lekter", "kajakk", "ferge", "trikk",
  "bro", "tårn", "slott", "hytte", "låve", "mølle", "havn", "marked", "kapell", "landsted", "jern", "kobber", "sølv", "gull", "marmor", "leire",
  "nøkkel", "lås", "mynt", "bjelle", "flagg", "drage", "tromme", "fløyte", "maske", "ring", "krone", "skjold", "lykt", "kompass", "fjær", "småstein",
];

export const WORDLISTS: Record<CodewordLocale, string[]> = { en: EN, nb: NB };
```

- [ ] **Step 2: Write the failing test for `codewords.ts`**

```typescript
// apps/api/src/lib/codewords.test.ts
import { describe, it, expect } from "vitest";
import { deriveCodewords, resolveLocale, CODEWORD_DEFAULT_COUNT, CODEWORD_MAX_COUNT } from "./codewords";
import { WORDLISTS } from "./wordlists";

const KEY_A = "cmVjaXBpZW50a2V5MTIzNDU2Nzg5MA==";
const KEY_B = "YW5vdGhlcmtleTk4NzY1NDMyMTA=";

describe("codewords", () => {
  it("is deterministic for the same key and locale", () => {
    const first = deriveCodewords(KEY_A, "en");
    const second = deriveCodewords(KEY_A, "en");
    expect(first).toEqual(second);
  });

  it("returns words that belong to the requested locale's wordlist", () => {
    const words = deriveCodewords(KEY_A, "nb", CODEWORD_MAX_COUNT);
    for (const word of words) {
      expect(WORDLISTS.nb).toContain(word);
    }
  });

  it("falls back to the default locale for an unsupported locale code", () => {
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("nb")).toBe("nb");
  });

  it("is prefix-stable across word counts", () => {
    const three = deriveCodewords(KEY_A, "en", CODEWORD_DEFAULT_COUNT);
    const five = deriveCodewords(KEY_A, "en", CODEWORD_MAX_COUNT);
    expect(five.slice(0, CODEWORD_DEFAULT_COUNT)).toEqual(three);
  });

  it("produces a different phrase for a different public key", () => {
    const wordsA = deriveCodewords(KEY_A, "en");
    const wordsB = deriveCodewords(KEY_B, "en");
    expect(wordsA).not.toEqual(wordsB);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/api test -- codewords`
Expected: FAIL — `./codewords` module not found.

- [ ] **Step 4: Write `apps/api/src/lib/codewords.ts`**

```typescript
// apps/api/src/lib/codewords.ts
import { createHash } from "node:crypto";
import { WORDLISTS, DEFAULT_LOCALE, type CodewordLocale } from "./wordlists";

export const CODEWORD_DEFAULT_COUNT = 3;
export const CODEWORD_MAX_COUNT = 5;

export function resolveLocale(locale: string | undefined): CodewordLocale {
  return locale === "en" || locale === "nb" ? locale : DEFAULT_LOCALE;
}

export function deriveCodewords(
  publicKeyBase64: string,
  locale: CodewordLocale,
  count: number = CODEWORD_MAX_COUNT
): string[] {
  const wordlist = WORDLISTS[locale];
  const keyBytes = Buffer.from(publicKeyBase64, "base64");
  const hash = createHash("sha256").update(keyBytes).digest();
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(wordlist[hash[i % hash.length]]);
  }
  return words;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/api test -- codewords`
Expected: PASS (all five tests).

- [ ] **Step 6: Modify `apps/api/src/lib/links.ts` to store the locale and include codewords**

Replace the whole file's content with:

```typescript
// apps/api/src/lib/links.ts
import { customAlphabet } from "nanoid";
import { prisma, type Link, type Drop } from "@e2ee-drop/db";
import type { DropSummary, LinkStatusResponse } from "@e2ee-drop/shared";
import { env } from "../env";
import { resolveLocale, deriveCodewords, CODEWORD_MAX_COUNT } from "./codewords";

const nanoid = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 16);

export async function createOneTimeLink(recipientPublicKey: string, locale?: string): Promise<Link> {
  return prisma.link.create({
    data: {
      slug: nanoid(),
      mode: "one-time",
      recipientPublicKey,
      codewordLocale: resolveLocale(locale),
      expiresAt: new Date(Date.now() + env.LINK_EXPIRY_HOURS * 60 * 60 * 1000),
    },
  });
}

export async function getLinkBySlug(slug: string): Promise<(Link & { drops: Drop[] }) | null> {
  return prisma.link.findFirst({ where: { slug }, include: { drops: true } });
}

export function isLinkExpired(link: Link): boolean {
  return link.expiresAt !== null && link.expiresAt.getTime() < Date.now();
}

export function toDropSummary(drop: Drop): DropSummary {
  return {
    id: drop.id,
    status: drop.status as DropSummary["status"],
    senderPublicKey: drop.senderPublicKey,
    nonce: drop.nonce,
    fileName: drop.fileName,
    fileSize: drop.fileSize,
    mimeType: drop.mimeType,
    contentMD5: drop.contentMD5,
    message: drop.message,
  };
}

export function toLinkStatusResponse(link: Link & { drops: Drop[] }): LinkStatusResponse {
  const activeDrop = link.drops[0] ?? null;
  return {
    slug: link.slug,
    mode: link.mode as LinkStatusResponse["mode"],
    recipientPublicKey: link.recipientPublicKey,
    drop: activeDrop ? toDropSummary(activeDrop) : null,
    isAnonymous: link.ownerId === null,
    codewords: deriveCodewords(
      link.recipientPublicKey,
      resolveLocale(link.codewordLocale),
      CODEWORD_MAX_COUNT
    ),
  };
}
```

- [ ] **Step 7: Modify `apps/api/src/routes/links.ts` to accept and pass through `locale`**

Replace the `POST /api/links` handler with:

```typescript
  server.post<{ Body: CreateLinkRequest }>("/api/links", async (request, reply) => {
    const { recipientPublicKey, locale } = request.body;
    if (!recipientPublicKey) {
      return reply.status(400).send({ error: "Missing recipientPublicKey" });
    }
    const link = await createOneTimeLink(recipientPublicKey, locale);
    const body: CreateLinkResponse = {
      linkId: link.id,
      slug: link.slug,
      codewords: deriveCodewords(link.recipientPublicKey, resolveLocale(link.codewordLocale), CODEWORD_MAX_COUNT),
    };
    return reply.send(body);
  });
```

Also add the import to the top of `apps/api/src/routes/links.ts`: `import { resolveLocale, deriveCodewords, CODEWORD_MAX_COUNT } from "../lib/codewords";`.

- [ ] **Step 8: Extend `apps/api/src/routes/links.test.ts` with a codewords assertion**

Add this test inside the existing `describe("link routes", ...)` block:

```typescript
  it("returns a codewords phrase on create and on the link status response", async () => {
    const server = buildServer();
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50a2V5", locale: "nb" },
    });
    const createBody = createResponse.json();
    expect(Array.isArray(createBody.codewords)).toBe(true);
    expect(createBody.codewords.length).toBeGreaterThan(0);

    const getResponse = await server.inject({ method: "GET", url: `/api/links/${createBody.slug}` });
    const body = getResponse.json();

    expect(body.codewords).toEqual(createBody.codewords);
  });
```

- [ ] **Step 9: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- links`
Expected: PASS (all four tests, including the new one).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/lib/wordlists.ts apps/api/src/lib/codewords.ts apps/api/src/lib/codewords.test.ts apps/api/src/lib/links.ts apps/api/src/routes/links.ts apps/api/src/routes/links.test.ts
git commit -m "feat(api): derive per-link verification codewords from the recipient public key"
```

### Task 10: Upload routes

**Files:**
- Create: `apps/api/src/routes/uploads.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/uploads.test.ts`

**Interfaces:**
- Consumes: `getLinkBySlug`, `isLinkExpired` from `../lib/links` (Task 9); `getSignedUploadUrl` from `../lib/storage` (Task 7); `env` from `../env` (Task 4); `RequestUploadUrlRequest`, `RequestUploadUrlResponse` from `@e2ee-drop/shared` (Task 3).
- Produces: registers `POST /api/links/:slug/upload-url` and `POST /api/links/:slug/drops/:dropId/complete` on the Fastify instance — consumed by Task 14 (sender page) via HTTP, and by Task 11 (a completed drop is what makes a download URL request valid).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/routes/uploads.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";

const validMetadata = {
  fileName: "report.pdf",
  fileSize: 1024,
  nonce: "bm9uY2U=",
  mimeType: "application/pdf",
  contentMD5: "bWQ1",
};

async function createLink(server: ReturnType<typeof buildServer>) {
  const res = await server.inject({
    method: "POST",
    url: "/api/links",
    payload: { recipientPublicKey: "cmVjaXBpZW50" },
  });
  return res.json().slug as string;
}

describe("upload routes", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("issues an upload url and creates a drop for a fresh link", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dropId).toBeTruthy();
    expect(body.uploadUrl).toContain("http");
  });

  it("rejects a file larger than MAX_FILE_SIZE_BYTES with 413", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: {
        senderPublicKey: "c2VuZGVy",
        metadata: { ...validMetadata, fileSize: 999_999_999_999 },
      },
    });

    expect(response.statusCode).toBe(413);
  });

  it("rejects a second upload-url request once a drop already exists", async () => {
    const server = buildServer();
    const slug = await createLink(server);

    const first = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVyMg==", metadata: validMetadata },
    });
    expect(second.statusCode).toBe(409);

    const drops = await prisma.drop.findMany({ where: { link: { slug } } });
    expect(drops).toHaveLength(1);
  });

  it("returns 404 for an expired link", async () => {
    const server = buildServer();
    const link = await prisma.link.create({
      data: {
        slug: "expired-upload-test",
        mode: "one-time",
        recipientPublicKey: "x",
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${link.slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    });

    expect(response.statusCode).toBe(404);
  });

  it("truncates a message longer than 500 characters and strips control characters", async () => {
    const server = buildServer();
    const slug = await createLink(server);
    const longMessage = "a".repeat(600) + "\x00\x1F";

    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", message: longMessage, metadata: validMetadata },
    });

    expect(response.statusCode).toBe(200);
    const drop = await prisma.drop.findFirst({ where: { link: { slug } } });
    expect(drop?.message).toHaveLength(500);
    expect(drop?.message).not.toMatch(/[\x00-\x1F\x7F]/);
  });

  it("marks a drop as uploaded via the complete endpoint", async () => {
    const server = buildServer();
    const slug = await createLink(server);
    const uploadRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/upload-url`,
      payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
    });
    const { dropId } = uploadRes.json();

    const completeRes = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/complete`,
    });
    expect(completeRes.statusCode).toBe(200);

    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("uploaded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- uploads`
Expected: FAIL — `./uploads` route module not found.

- [ ] **Step 3: Write `apps/api/src/routes/uploads.ts`**

```typescript
// apps/api/src/routes/uploads.ts
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { prisma } from "@e2ee-drop/db";
import type { RequestUploadUrlRequest, RequestUploadUrlResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired } from "../lib/links";
import { getSignedUploadUrl } from "../lib/storage";
import { env } from "../env";

const MAX_MESSAGE_LENGTH = 500;

function sanitizeMessage(message: string | undefined): string | null {
  if (!message) return null;
  // eslint-disable-next-line no-control-regex
  const stripped = message.replace(/[\x00-\x1F\x7F]/g, "");
  return stripped.slice(0, MAX_MESSAGE_LENGTH) || null;
}

export function registerUploadRoutes(server: FastifyInstance): void {
  server.post<{ Params: { slug: string }; Body: RequestUploadUrlRequest }>(
    "/api/links/:slug/upload-url",
    async (request, reply) => {
      const link = await getLinkBySlug(request.params.slug);
      if (!link) return reply.status(404).send({ error: "Link not found" });
      if (isLinkExpired(link)) {
        await prisma.link.delete({ where: { id: link.id } });
        return reply.status(404).send({ error: "Link not found" });
      }
      if (link.drops.length > 0) {
        return reply.status(409).send({ error: "Link already has a pending or completed drop" });
      }

      const { senderPublicKey, message, metadata } = request.body;
      if (!senderPublicKey || !metadata?.fileName || !metadata?.nonce || !metadata?.mimeType || !metadata?.contentMD5 || !metadata?.fileSize) {
        return reply.status(400).send({ error: "Missing metadata" });
      }
      if (metadata.fileSize > env.MAX_FILE_SIZE_BYTES) {
        return reply.status(413).send({ error: `File too large (max ${env.MAX_FILE_SIZE_BYTES} bytes)` });
      }

      const dropId = nanoid();
      const s3Key = `${link.id}/${dropId}`;
      await prisma.drop.create({
        data: {
          id: dropId,
          linkId: link.id,
          senderPublicKey,
          s3Key,
          nonce: metadata.nonce,
          fileName: metadata.fileName,
          fileSize: metadata.fileSize,
          mimeType: metadata.mimeType,
          contentMD5: metadata.contentMD5,
          message: sanitizeMessage(message),
          status: "uploading",
        },
      });

      const uploadUrl = await getSignedUploadUrl(s3Key);
      const body: RequestUploadUrlResponse = { dropId, uploadUrl };
      return reply.send(body);
    }
  );

  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/complete",
    async (request, reply) => {
      const drop = await prisma.drop.findUnique({ where: { id: request.params.dropId } });
      if (!drop) return reply.status(404).send({ error: "Drop not found" });
      await prisma.drop.update({ where: { id: drop.id }, data: { status: "uploaded" } });
      return reply.send({ updated: true });
    }
  );
}
```

- [ ] **Step 4: Register the routes in `apps/api/src/server.ts`**

```typescript
// apps/api/src/server.ts
import Fastify, { FastifyInstance } from "fastify";
import { registerLinkRoutes } from "./routes/links";
import { registerUploadRoutes } from "./routes/uploads";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/api/health", async () => ({ status: "ok" }));
  registerLinkRoutes(server);
  registerUploadRoutes(server);

  return server;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- uploads`
Expected: PASS (all six tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/uploads.ts apps/api/src/routes/uploads.test.ts apps/api/src/server.ts
git commit -m "feat(api): add upload-url and upload-complete routes with quota/size/message guards"
```

### Task 11: Download routes

**Files:**
- Create: `apps/api/src/routes/downloads.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/downloads.test.ts`

**Interfaces:**
- Consumes: `getLinkBySlug`, `isLinkExpired` from `../lib/links` (Task 9); `getSignedDownloadUrl` from `../lib/storage` (Task 7); `DownloadUrlResponse` from `@e2ee-drop/shared` (Task 3).
- Produces: registers `GET /api/links/:slug/download-url` and `POST /api/links/:slug/drops/:dropId/downloaded` — consumed by Task 15 (recipient page) via HTTP.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/routes/downloads.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildServer } from "../server";
import { prisma } from "@e2ee-drop/db";

const validMetadata = {
  fileName: "report.pdf",
  fileSize: 1024,
  nonce: "bm9uY2U=",
  mimeType: "application/pdf",
  contentMD5: "bWQ1",
};

async function createLinkWithDrop(
  server: ReturnType<typeof buildServer>,
  dropStatus: "uploading" | "uploaded"
) {
  const createRes = await server.inject({
    method: "POST",
    url: "/api/links",
    payload: { recipientPublicKey: "cmVjaXBpZW50" },
  });
  const { slug } = createRes.json();

  const uploadRes = await server.inject({
    method: "POST",
    url: `/api/links/${slug}/upload-url`,
    payload: { senderPublicKey: "c2VuZGVy", metadata: validMetadata },
  });
  const { dropId } = uploadRes.json();

  if (dropStatus === "uploaded") {
    await server.inject({ method: "POST", url: `/api/links/${slug}/drops/${dropId}/complete` });
  }

  return { slug, dropId };
}

describe("download routes", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("issues a download url once the drop is uploaded", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server, "uploaded");

    const response = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.downloadUrl).toContain("http");
    expect(body.fileName).toBe("report.pdf");
  });

  it("rejects a download-url request while the drop is still uploading", async () => {
    const server = buildServer();
    const { slug } = await createLinkWithDrop(server, "uploading");

    const response = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(response.statusCode).toBe(403);
  });

  it("returns 404 when the link has no drop at all", async () => {
    const server = buildServer();
    const createRes = await server.inject({
      method: "POST",
      url: "/api/links",
      payload: { recipientPublicKey: "cmVjaXBpZW50" },
    });
    const { slug } = createRes.json();

    const response = await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });

    expect(response.statusCode).toBe(404);
  });

  it("marks a drop as downloaded via the downloaded endpoint", async () => {
    const server = buildServer();
    const { slug, dropId } = await createLinkWithDrop(server, "uploaded");

    await server.inject({ method: "GET", url: `/api/links/${slug}/download-url` });
    const response = await server.inject({
      method: "POST",
      url: `/api/links/${slug}/drops/${dropId}/downloaded`,
    });

    expect(response.statusCode).toBe(200);
    const drop = await prisma.drop.findUnique({ where: { id: dropId } });
    expect(drop?.status).toBe("downloaded");
  });

  it("returns 404 for an expired link even if a drop was uploaded before it expired", async () => {
    const server = buildServer();
    const link = await prisma.link.create({
      data: {
        slug: "expired-download-test",
        mode: "one-time",
        recipientPublicKey: "x",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.drop.create({
      data: {
        linkId: link.id,
        senderPublicKey: "c2VuZGVy",
        s3Key: `${link.id}/drop1`,
        nonce: validMetadata.nonce,
        fileName: validMetadata.fileName,
        fileSize: validMetadata.fileSize,
        mimeType: validMetadata.mimeType,
        contentMD5: validMetadata.contentMD5,
        status: "uploaded",
      },
    });

    const response = await server.inject({ method: "GET", url: `/api/links/${link.slug}/download-url` });

    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- downloads`
Expected: FAIL — `./downloads` route module not found.

- [ ] **Step 3: Write `apps/api/src/routes/downloads.ts`**

```typescript
// apps/api/src/routes/downloads.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "@e2ee-drop/db";
import type { DownloadUrlResponse } from "@e2ee-drop/shared";
import { getLinkBySlug, isLinkExpired } from "../lib/links";
import { getSignedDownloadUrl } from "../lib/storage";

export function registerDownloadRoutes(server: FastifyInstance): void {
  server.get<{ Params: { slug: string } }>("/api/links/:slug/download-url", async (request, reply) => {
    const link = await getLinkBySlug(request.params.slug);
    if (!link) return reply.status(404).send({ error: "Link not found" });
    if (isLinkExpired(link)) {
      await prisma.link.delete({ where: { id: link.id } });
      return reply.status(404).send({ error: "Link not found" });
    }
    const drop = link.drops[0];
    if (!drop) return reply.status(404).send({ error: "No uploaded file for this link" });
    if (drop.status !== "uploaded") {
      return reply.status(403).send({ error: "File is not ready for download yet" });
    }

    const downloadUrl = await getSignedDownloadUrl(drop.s3Key);
    await prisma.drop.update({ where: { id: drop.id }, data: { status: "downloading" } });

    const body: DownloadUrlResponse = {
      downloadUrl,
      fileName: drop.fileName,
      fileSize: drop.fileSize,
      mimeType: drop.mimeType,
      nonce: drop.nonce,
      senderPublicKey: drop.senderPublicKey,
      contentMD5: drop.contentMD5,
    };
    return reply.send(body);
  });

  server.post<{ Params: { slug: string; dropId: string } }>(
    "/api/links/:slug/drops/:dropId/downloaded",
    async (request, reply) => {
      const drop = await prisma.drop.findUnique({ where: { id: request.params.dropId } });
      if (!drop) return reply.status(404).send({ error: "Drop not found" });
      await prisma.drop.update({ where: { id: drop.id }, data: { status: "downloaded" } });
      return reply.send({ updated: true });
    }
  );
}
```

- [ ] **Step 4: Register the routes in `apps/api/src/server.ts`**

```typescript
// apps/api/src/server.ts
import Fastify, { FastifyInstance } from "fastify";
import { registerLinkRoutes } from "./routes/links";
import { registerUploadRoutes } from "./routes/uploads";
import { registerDownloadRoutes } from "./routes/downloads";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/api/health", async () => ({ status: "ok" }));
  registerLinkRoutes(server);
  registerUploadRoutes(server);
  registerDownloadRoutes(server);

  return server;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- downloads`
Expected: PASS (all five tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/downloads.ts apps/api/src/routes/downloads.test.ts apps/api/src/server.ts
git commit -m "feat(api): add download-url and mark-downloaded routes"
```

### Task 12: Cleanup job

**Files:**
- Create: `apps/api/src/jobs/cleanup.ts`
- Test: `apps/api/src/jobs/cleanup.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@e2ee-drop/db` (Task 2); `deleteObject` from `../lib/storage` (Task 7); `isLinkExpired` from `../lib/links` (Task 9).
- Produces: `runCleanup(): Promise<{ deletedLinks: number }>`, invoked once at process start by the `cleanup` Compose service (Task 6's `command` runs this file directly via `tsx`).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/jobs/cleanup.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@e2ee-drop/db";

vi.mock("../lib/storage", () => ({ deleteObject: vi.fn().mockResolvedValue(undefined) }));

import { runCleanup } from "./cleanup";

describe("runCleanup", () => {
  beforeEach(async () => {
    await prisma.drop.deleteMany();
    await prisma.link.deleteMany();
  });

  it("deletes expired one-time links and their drops", async () => {
    await prisma.link.create({
      data: {
        slug: "expired-link",
        mode: "one-time",
        recipientPublicKey: "x",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.link.create({
      data: {
        slug: "fresh-link",
        mode: "one-time",
        recipientPublicKey: "x",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await runCleanup();

    expect(result.deletedLinks).toBe(1);
    expect(await prisma.link.findFirst({ where: { slug: "expired-link" } })).toBeNull();
    expect(await prisma.link.findFirst({ where: { slug: "fresh-link" } })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- cleanup`
Expected: FAIL — `./cleanup` module not found.

- [ ] **Step 3: Write `apps/api/src/jobs/cleanup.ts`**

```typescript
// apps/api/src/jobs/cleanup.ts
import { prisma } from "@e2ee-drop/db";
import { deleteObject } from "../lib/storage";

export async function runCleanup(): Promise<{ deletedLinks: number }> {
  const now = new Date();
  const expiredLinks = await prisma.link.findMany({
    where: { mode: "one-time", expiresAt: { lt: now } },
    include: { drops: true },
  });

  for (const link of expiredLinks) {
    for (const drop of link.drops) {
      await deleteObject(drop.s3Key);
    }
    await prisma.link.delete({ where: { id: link.id } });
  }

  return { deletedLinks: expiredLinks.length };
}

async function main() {
  const INTERVAL_MS = 15 * 60 * 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await runCleanup();
      console.log(`[cleanup] removed ${result.deletedLinks} expired link(s)`);
    } catch (error) {
      console.error("[cleanup] sweep failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://e2eedrop:change-me@localhost:5432/e2eedrop MINIO_ENDPOINT=http://localhost:9000 MINIO_BUCKET=e2ee-drop MINIO_ACCESS_KEY=minioadmin MINIO_SECRET_KEY=change-me-too pnpm --filter @e2ee-drop/api test -- cleanup`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/cleanup.ts apps/api/src/jobs/cleanup.test.ts
git commit -m "feat(api): add retention cleanup job for expired one-time links"
```

---

## Wave 3 — Frontend pages (parallel; each depends on Task 8 for crypto, Task 3 for types, and reads the matching Wave 2 API route for its request/response shape)

### Task 13: Local link storage hook + "receive a file" (create-link) page

**Files:**
- Create: `apps/web/src/hooks/useLocalLinks.ts`
- Create: `apps/web/src/components/CreateLinkPage.tsx`
- Create: `apps/web/src/locales/en/createLink.json`, `apps/web/src/locales/nb/createLink.json`
- Test: `apps/web/src/components/CreateLinkPage.test.tsx`

**Interfaces:**
- Consumes: nothing from other Wave 2/3 tasks (talks to `POST /api/links` from Task 9 directly over `fetch`).
- Produces: `useLocalLinks()` hook exposing `{ links: Record<string, { privateKey: string; createdAt: number; expiresAt: number }>, saveLink(slug: string, privateKey: string, expiresAt: number): void, removeLink(slug: string): void }` — consumed by Task 15. `<CreateLinkPage />` component, a component later routed at `/create` by Task 16.

- [ ] **Step 1: Write `apps/web/src/hooks/useLocalLinks.ts`**

```typescript
// apps/web/src/hooks/useLocalLinks.ts
import { useCallback, useEffect, useState } from "react";

export interface StoredLink {
  privateKey: string; // base64
  createdAt: number;
  expiresAt: number;
}

type LocalLinks = Record<string, StoredLink>;

const STORAGE_KEY = "e2ee-drop:links";

export function useLocalLinks() {
  const [links, setLinks] = useState<LocalLinks>(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed: LocalLinks = JSON.parse(raw);
      const now = Date.now();
      for (const slug of Object.keys(parsed)) {
        if (parsed[slug].expiresAt < now) delete parsed[slug];
      }
      return parsed;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
    } catch {
      // localStorage unavailable (private mode / quota) — link still usable for this tab session
    }
  }, [links]);

  const saveLink = useCallback((slug: string, privateKey: string, expiresAt: number) => {
    setLinks((prev) => ({ ...prev, [slug]: { privateKey, createdAt: Date.now(), expiresAt } }));
  }, []);

  const removeLink = useCallback((slug: string) => {
    setLinks((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }, []);

  return { links, saveLink, removeLink };
}
```

- [ ] **Step 2: Write locale files**

```json
// apps/web/src/locales/en/createLink.json
{
  "title": "Receive a file",
  "creating": "Creating your link…",
  "copyLink": "Copy link",
  "copied": "Copied!",
  "codewordsLabel": "Verification words — read these aloud to confirm the sender has the right link",
  "showMoreWords": "Show more words",
  "showFewerWords": "Show fewer words",
  "errors": { "createFailed": "Could not create a link. Please try again." }
}
```

```json
// apps/web/src/locales/nb/createLink.json
{
  "title": "Motta en fil",
  "creating": "Oppretter lenken din…",
  "copyLink": "Kopier lenke",
  "copied": "Kopiert!",
  "codewordsLabel": "Verifiseringsord — les disse høyt for å bekrefte at avsenderen har riktig lenke",
  "showMoreWords": "Vis flere ord",
  "showFewerWords": "Vis færre ord",
  "errors": { "createFailed": "Kunne ikke opprette lenke. Prøv igjen." }
}
```

- [ ] **Step 3: Write the failing test**

```tsx
// apps/web/src/components/CreateLinkPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CreateLinkPage } from "./CreateLinkPage";

describe("CreateLinkPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ linkId: "link1", slug: "abc123", codewords: ["fox", "river", "lamp"] }),
      })
    );
  });

  it("creates a link and shows the shareable URL", async () => {
    render(<CreateLinkPage />);

    await waitFor(() => {
      expect(screen.getByText(/abc123/)).toBeInTheDocument();
    });
  });

  it("shows the verification codewords", async () => {
    render(<CreateLinkPage />);

    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- CreateLinkPage`
Expected: FAIL — `./CreateLinkPage` module not found.

- [ ] **Step 5: Write `apps/web/src/components/CreateLinkPage.tsx`**

```tsx
// apps/web/src/components/CreateLinkPage.tsx
import { useEffect, useState } from "react";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import i18n from "@/i18n";
import createLinkEn from "@/locales/en/createLink.json";
import createLinkNb from "@/locales/nb/createLink.json";

i18n.addResourceBundle("en", "createLink", createLinkEn, true, false);
i18n.addResourceBundle("nb", "createLink", createLinkNb, true, false);

const LINK_EXPIRY_MS = 24 * 60 * 60 * 1000;
const CODEWORD_DEFAULT_COUNT = 3;

export function CreateLinkPage() {
  const { t, i18n: i18next } = useTranslation("createLink");
  const { saveLink } = useLocalLinks();
  const [slug, setSlug] = useState<string | null>(null);
  const [codewords, setCodewords] = useState<string[]>([]);
  const [showAllCodewords, setShowAllCodewords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (slug) return;
    let cancelled = false;
    async function create() {
      try {
        const keyPair = nacl.box.keyPair();
        const locale = i18next.language?.startsWith("nb") ? "nb" : "en";
        const response = await fetch("/api/links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipientPublicKey: encodeBase64(keyPair.publicKey), locale }),
        });
        if (!response.ok) throw new Error("create failed");
        const body = await response.json();
        if (cancelled) return;
        saveLink(body.slug, encodeBase64(keyPair.secretKey), Date.now() + LINK_EXPIRY_MS);
        setSlug(body.slug);
        setCodewords(body.codewords ?? []);
      } catch {
        if (!cancelled) setError(t("errors.createFailed"));
      }
    }
    create();
    return () => {
      cancelled = true;
    };
  }, [slug, saveLink, t, i18next]);

  const link = slug ? `${window.location.origin}/send/${slug}` : null;
  const visibleCodewords = showAllCodewords ? codewords : codewords.slice(0, CODEWORD_DEFAULT_COUNT);

  const copyLink = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
  };

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert">{error}</p>}
        {link && (
          <>
            <p className="break-all rounded bg-muted p-2 text-sm">{link}</p>
            <Button onClick={copyLink}>{copied ? t("copied") : t("copyLink")}</Button>
            <div>
              <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
              <p className="font-mono text-lg">{visibleCodewords.join(" · ")}</p>
              {codewords.length > CODEWORD_DEFAULT_COUNT && (
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => setShowAllCodewords((v) => !v)}
                >
                  {showAllCodewords ? t("showFewerWords") : t("showMoreWords")}
                </button>
              )}
            </div>
          </>
        )}
        {!link && !error && <p>{t("creating")}</p>}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- CreateLinkPage`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/hooks/useLocalLinks.ts apps/web/src/components/CreateLinkPage.tsx apps/web/src/components/CreateLinkPage.test.tsx apps/web/src/locales/en/createLink.json apps/web/src/locales/nb/createLink.json
git commit -m "feat(web): add local link storage hook and receive-a-file page"
```

### Task 14: Upload (sender) page — recipient identity + optional unencrypted message

**Files:**
- Create: `apps/web/src/components/UploadPage.tsx`
- Create: `apps/web/src/locales/en/upload.json`, `apps/web/src/locales/nb/upload.json`
- Test: `apps/web/src/components/UploadPage.test.tsx`

**Interfaces:**
- Consumes: `useFileEncryption` from `@/hooks/useFileEncryption` (Task 8); talks to `GET /api/links/:slug` (Task 9) and `POST /api/links/:slug/upload-url` + `POST /api/links/:slug/drops/:dropId/complete` (Task 10) over `fetch`.
- Produces: `<UploadPage />`, a component later routed at `/send/:slug` by Task 16.

- [ ] **Step 1: Write locale files**

```json
// apps/web/src/locales/en/upload.json
{
  "title": "Send a file",
  "loading": "Loading link…",
  "anonymousRecipient": "Anonymous recipient (no verified identity for this link)",
  "verifiedRecipient": "Sending to a registered account",
  "codewordsLabel": "Verification words — ask the recipient to confirm these match",
  "messagePlaceholder": "Optional message (not encrypted)",
  "messageNotEncryptedWarning": "This message is NOT end-to-end encrypted — unlike the file, it can be read by whoever operates this server.",
  "success": "File sent successfully.",
  "errors": { "linkNotFound": "This link is invalid or has expired.", "uploadFailed": "Upload failed. Please try again." }
}
```

```json
// apps/web/src/locales/nb/upload.json
{
  "title": "Send en fil",
  "loading": "Laster lenke…",
  "anonymousRecipient": "Anonym mottaker (ingen verifisert identitet for denne lenken)",
  "verifiedRecipient": "Sender til en registrert konto",
  "codewordsLabel": "Verifiseringsord — be mottakeren bekrefte at disse stemmer",
  "messagePlaceholder": "Valgfri melding (ikke kryptert)",
  "messageNotEncryptedWarning": "Denne meldingen er IKKE ende-til-ende-kryptert — i motsetning til filen kan den leses av den som drifter serveren.",
  "success": "Filen ble sendt.",
  "errors": { "linkNotFound": "Denne lenken er ugyldig eller utløpt.", "uploadFailed": "Opplasting feilet. Prøv igjen." }
}
```

- [ ] **Step 2: Write the failing test**

```tsx
// apps/web/src/components/UploadPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/hooks/useFileEncryption", () => ({
  useFileEncryption: () => ({
    setKeyPair: vi.fn(),
    encryptFile: vi.fn(),
    isProcessing: false,
    progress: 0,
  }),
}));

import { UploadPage } from "./UploadPage";

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/send/${slug}`]}>
      <Routes>
        <Route path="/send/:slug" element={<UploadPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("UploadPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          recipientPublicKey: "cmVjaXBpZW50",
          isAnonymous: true,
          codewords: ["fox", "river", "lamp"],
        }),
      })
    );
  });

  it("shows the verification codewords", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp/i)).toBeInTheDocument();
    });
  });

  it("shows the anonymous-recipient indicator for an ownerless link", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toHaveTextContent(/anonymous/i);
    });
  });

  it("shows the not-encrypted warning next to the message field", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/not end-to-end encrypted/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- UploadPage`
Expected: FAIL — `./UploadPage` module not found.

- [ ] **Step 4: Write `apps/web/src/components/UploadPage.tsx`**

```tsx
// apps/web/src/components/UploadPage.tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import nacl from "tweetnacl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useFileEncryption } from "@/hooks/useFileEncryption";
import i18n from "@/i18n";
import uploadEn from "@/locales/en/upload.json";
import uploadNb from "@/locales/nb/upload.json";

i18n.addResourceBundle("en", "upload", uploadEn, true, false);
i18n.addResourceBundle("nb", "upload", uploadNb, true, false);

const MAX_MESSAGE_LENGTH = 500;

interface LinkStatus {
  recipientPublicKey: string;
  isAnonymous: boolean;
  codewords: string[];
}

export function UploadPage() {
  const { t } = useTranslation("upload");
  const { slug } = useParams<{ slug: string }>();
  const [link, setLink] = useState<LinkStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const { setKeyPair, encryptFile } = useFileEncryption();

  useEffect(() => {
    setKeyPair(nacl.box.keyPair());
  }, [setKeyPair]);

  useEffect(() => {
    if (!slug) return;
    fetch(`/api/links/${slug}`)
      .then((res) => {
        if (!res.ok) throw new Error("not found");
        return res.json();
      })
      .then((data) =>
        setLink({
          recipientPublicKey: data.recipientPublicKey,
          isAnonymous: data.isAnonymous,
          codewords: data.codewords ?? [],
        })
      )
      .catch(() => setError(t("errors.linkNotFound")));
  }, [slug, t]);

  const handleFile = async (file: File) => {
    if (!link || !slug) return;
    try {
      const encrypted = await encryptFile(file, link.recipientPublicKey);
      const uploadUrlRes = await fetch(`/api/links/${slug}/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderPublicKey: encrypted.senderPublicKey,
          message: message || undefined,
          metadata: {
            fileName: encrypted.fileName,
            fileSize: encrypted.fileSize,
            nonce: encrypted.nonce,
            mimeType: encrypted.mimeType,
            contentMD5: encrypted.contentMD5,
          },
        }),
      });
      if (!uploadUrlRes.ok) throw new Error("upload-url failed");
      const { dropId, uploadUrl } = await uploadUrlRes.json();

      const putRes = await fetch(uploadUrl, { method: "PUT", body: encrypted.encrypted });
      if (!putRes.ok) throw new Error("upload failed");

      await fetch(`/api/links/${slug}/drops/${dropId}/complete`, { method: "POST" });
      setDone(true);
    } catch {
      setError(t("errors.uploadFailed"));
    }
  };

  if (error) {
    return (
      <Alert variant="destructive" className="mx-auto mt-12 max-w-md">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!link) return <p>{t("loading")}</p>;
  if (done) return <p>{t("success")}</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div data-testid="recipient-badge">
          {link.isAnonymous ? t("anonymousRecipient") : t("verifiedRecipient")}
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
          <p className="font-mono text-lg">{link.codewords.slice(0, 3).join(" · ")}</p>
        </div>
        <textarea
          value={message}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t("messagePlaceholder")}
          className="w-full rounded border p-2 text-sm"
        />
        <Alert>
          <AlertDescription>{t("messageNotEncryptedWarning")}</AlertDescription>
        </Alert>
        <input type="file" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- UploadPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/UploadPage.tsx apps/web/src/components/UploadPage.test.tsx apps/web/src/locales/en/upload.json apps/web/src/locales/nb/upload.json
git commit -m "feat(web): add sender upload page with recipient identity and unencrypted-message notice"
```

### Task 15: Download page

**Files:**
- Create: `apps/web/src/components/DownloadPage.tsx`
- Create: `apps/web/src/locales/en/download.json`, `apps/web/src/locales/nb/download.json`
- Test: `apps/web/src/components/DownloadPage.test.tsx`

**Interfaces:**
- Consumes: `useLocalLinks` from `@/hooks/useLocalLinks` (Task 13); `useFileEncryption` from `@/hooks/useFileEncryption` (Task 8); talks to `GET /api/links/:slug` (Task 9), `GET /api/links/:slug/download-url` and `POST /api/links/:slug/drops/:dropId/downloaded` (Task 11) over `fetch`.
- Produces: `<DownloadPage />`, routed at `/download/:slug`.

- [ ] **Step 1: Write locale files**

```json
// apps/web/src/locales/en/download.json
{
  "title": "Receive a file",
  "codewordsLabel": "Verification words — share these with the sender to confirm",
  "waitingForFile": "Waiting for the file to be uploaded…",
  "downloadButton": "Download and decrypt",
  "downloadedMessage": "File downloaded and decrypted.",
  "errors": { "linkNotFound": "This link is invalid or has expired.", "downloadFailed": "Download failed. Please try again.", "noLocalKey": "No private key found for this link in this browser." }
}
```

```json
// apps/web/src/locales/nb/download.json
{
  "title": "Motta en fil",
  "codewordsLabel": "Verifiseringsord — del disse med avsenderen for bekreftelse",
  "waitingForFile": "Venter på at filen skal lastes opp…",
  "downloadButton": "Last ned og dekrypter",
  "downloadedMessage": "Filen ble lastet ned og dekryptert.",
  "errors": { "linkNotFound": "Denne lenken er ugyldig eller utløpt.", "downloadFailed": "Nedlasting feilet. Prøv igjen.", "noLocalKey": "Fant ingen privatnøkkel for denne lenken i denne nettleseren." }
}
```

- [ ] **Step 2: Write the failing test**

```tsx
// apps/web/src/components/DownloadPage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/hooks/useLocalLinks", () => ({
  useLocalLinks: () => ({
    links: { abc123: { privateKey: "c2VjcmV0", createdAt: Date.now(), expiresAt: Date.now() + 60_000 } },
    saveLink: vi.fn(),
    removeLink: vi.fn(),
  }),
}));

vi.mock("@/hooks/useFileEncryption", () => ({
  useFileEncryption: () => ({
    setKeyPair: vi.fn(),
    decryptFile: vi.fn(),
    isProcessing: false,
    progress: 0,
  }),
}));

import { DownloadPage } from "./DownloadPage";

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/download/${slug}`]}>
      <Routes>
        <Route path="/download/:slug" element={<DownloadPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("DownloadPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          drop: {
            id: "drop1",
            status: "uploaded",
            fileName: "report.pdf",
            message: "here's the file",
          },
          codewords: ["fox", "river", "lamp"],
        }),
      })
    );
  });

  it("shows the verification codewords", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp/i)).toBeInTheDocument();
    });
  });

  it("shows the download button once the drop is uploaded", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- DownloadPage`
Expected: FAIL — `./DownloadPage` module not found.

- [ ] **Step 4: Write `apps/web/src/components/DownloadPage.tsx`**

```tsx
// apps/web/src/components/DownloadPage.tsx
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { decodeBase64 } from "tweetnacl-util";
import nacl from "tweetnacl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocalLinks } from "@/hooks/useLocalLinks";
import { useFileEncryption } from "@/hooks/useFileEncryption";
import i18n from "@/i18n";
import downloadEn from "@/locales/en/download.json";
import downloadNb from "@/locales/nb/download.json";

i18n.addResourceBundle("en", "download", downloadEn, true, false);
i18n.addResourceBundle("nb", "download", downloadNb, true, false);

const POLL_INTERVAL_MS = 3000;

interface DropInfo {
  id: string;
  status: string;
  fileName: string;
  message: string | null;
}

export function DownloadPage() {
  const { t } = useTranslation("download");
  const { slug } = useParams<{ slug: string }>();
  const { links } = useLocalLinks();
  const { setKeyPair, decryptFile } = useFileEncryption();
  const [drop, setDrop] = useState<DropInfo | null>(null);
  const [codewords, setCodewords] = useState<string[]>([]);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const stored = slug ? links[slug] : undefined;

  useEffect(() => {
    if (!stored) return;
    setKeyPair(nacl.box.keyPair.fromSecretKey(decodeBase64(stored.privateKey)));
  }, [stored, setKeyPair]);

  useEffect(() => {
    if (!slug || !stored) return;
    async function poll() {
      const res = await fetch(`/api/links/${slug}`);
      if (!res.ok) {
        setError(t("errors.linkNotFound"));
        clearInterval(pollRef.current);
        return;
      }
      const data = await res.json();
      setDrop(data.drop);
      setCodewords(data.codewords ?? []);
      if (data.drop?.status === "uploaded") clearInterval(pollRef.current);
    }
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [slug, stored, t]);

  const handleDownload = async () => {
    if (!slug || !drop) return;
    try {
      const res = await fetch(`/api/links/${slug}/download-url`);
      if (!res.ok) throw new Error("download-url failed");
      const info = await res.json();
      const fileRes = await fetch(info.downloadUrl);
      const blob = await fileRes.blob();
      const file = await decryptFile(blob, {
        nonce: info.nonce,
        senderPublicKey: info.senderPublicKey,
        fileName: info.fileName,
        mimeType: info.mimeType,
      });
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
      await fetch(`/api/links/${slug}/drops/${drop.id}/downloaded`, { method: "POST" });
      setDownloaded(true);
    } catch {
      setError(t("errors.downloadFailed"));
    }
  };

  if (!stored) return <p>{t("errors.noLocalKey")}</p>;
  if (error) return <p role="alert">{error}</p>;

  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {codewords.length > 0 && (
          <div>
            <p className="text-sm text-muted-foreground">{t("codewordsLabel")}</p>
            <p className="font-mono text-lg">{codewords.slice(0, 3).join(" · ")}</p>
          </div>
        )}
        {(!drop || drop.status !== "uploaded") && !downloaded && <p>{t("waitingForFile")}</p>}
        {drop && drop.status === "uploaded" && !downloaded && (
          <>
            <p>{drop.fileName}</p>
            {drop.message && <p className="italic">{drop.message}</p>}
            <Button onClick={handleDownload}>{t("downloadButton")}</Button>
          </>
        )}
        {downloaded && <p>{t("downloadedMessage")}</p>}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- DownloadPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/DownloadPage.tsx apps/web/src/components/DownloadPage.test.tsx apps/web/src/locales/en/download.json apps/web/src/locales/nb/download.json
git commit -m "feat(web): add download page with polling and client-side decryption"
```

---

## Wave 4 — Integration (sequential; each depends on all of Wave 3, and on Task 6/Task 7)

### Task 16: Wire up routing and bucket initialization

**Files:**
- Create: `apps/web/src/components/HomePage.tsx`
- Create: `apps/web/src/locales/en/home.json`, `apps/web/src/locales/nb/home.json`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/api/src/index.ts`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `<CreateLinkPage />` (Task 13), `<UploadPage />` (Task 14), `<DownloadPage />` (Task 15), `ensureBucket` from `../lib/storage` (Task 7).
- Produces: a fully routed SPA (`/`, `/create`, `/send/:slug`, `/download/:slug`) and an `api` process that ensures its MinIO bucket exists before it starts accepting requests.

- [ ] **Step 1: Write locale files**

```json
// apps/web/src/locales/en/home.json
{ "title": "e2ee-drop", "tagline": "End-to-end encrypted file drops.", "receiveButton": "Receive a file" }
```

```json
// apps/web/src/locales/nb/home.json
{ "title": "e2ee-drop", "tagline": "Ende-til-ende-krypterte fildråper.", "receiveButton": "Motta en fil" }
```

- [ ] **Step 2: Write `apps/web/src/components/HomePage.tsx`**

```tsx
// apps/web/src/components/HomePage.tsx
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import i18n from "@/i18n";
import homeEn from "@/locales/en/home.json";
import homeNb from "@/locales/nb/home.json";

i18n.addResourceBundle("en", "home", homeEn, true, false);
i18n.addResourceBundle("nb", "home", homeNb, true, false);

export function HomePage() {
  const { t } = useTranslation("home");
  return (
    <div className="mx-auto mt-24 max-w-md text-center">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-muted-foreground">{t("tagline")}</p>
      <Button asChild className="mt-6">
        <Link to="/create">{t("receiveButton")}</Link>
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Write the failing test**

```tsx
// apps/web/src/App.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

describe("App routing", () => {
  it("renders the home page at /", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByText(/end-to-end encrypted file drops/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @e2ee-drop/web test -- App`
Expected: FAIL — current `App.tsx` (Task 5's placeholder) does not render the home page text, and does not accept an external `<MemoryRouter>` (it has no routes at all).

- [ ] **Step 5: Rewrite `apps/web/src/App.tsx`**

```tsx
// apps/web/src/App.tsx
import { Routes, Route } from "react-router-dom";
import { HomePage } from "@/components/HomePage";
import { CreateLinkPage } from "@/components/CreateLinkPage";
import { UploadPage } from "@/components/UploadPage";
import { DownloadPage } from "@/components/DownloadPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/create" element={<CreateLinkPage />} />
      <Route path="/send/:slug" element={<UploadPage />} />
      <Route path="/download/:slug" element={<DownloadPage />} />
    </Routes>
  );
}
```

- [ ] **Step 6: Wrap the app in a router in `apps/web/src/main.tsx`**

```tsx
// apps/web/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./i18n";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @e2ee-drop/web test -- App`
Expected: PASS.

- [ ] **Step 8: Wire `ensureBucket()` into API startup — rewrite `apps/api/src/index.ts`**

```typescript
// apps/api/src/index.ts
import { buildServer } from "./server";
import { env } from "./env";
import { ensureBucket } from "./lib/storage";

async function main() {
  await ensureBucket();
  const server = buildServer();
  await server.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/HomePage.tsx apps/web/src/components/App.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/main.tsx apps/web/src/locales/en/home.json apps/web/src/locales/nb/home.json apps/api/src/index.ts
git commit -m "feat: wire up SPA routing and MinIO bucket initialization on API startup"
```

### Task 17: Full-stack verification script

**Files:**
- Create: `scripts/verify-e2e.mjs`
- Modify: `package.json` (root)

**Interfaces:**
- Consumes: the running Docker Compose stack (Tasks 6, 9, 10, 11, 16) over HTTP — no code-level interface, this is the plan's final integration check.
- Produces: `node scripts/verify-e2e.mjs` — an automated round-trip check standing in for manual browser testing, runnable in CI later.

- [ ] **Step 1: Add `tweetnacl` as a root devDependency**

Edit root `package.json`, add to `devDependencies`: `"tweetnacl": "^1.0.3"`.

- [ ] **Step 2: Write `scripts/verify-e2e.mjs`**

```javascript
// scripts/verify-e2e.mjs
import nacl from "tweetnacl";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function fromB64(str) {
  return new Uint8Array(Buffer.from(str, "base64"));
}

async function main() {
  const recipient = nacl.box.keyPair();
  const sender = nacl.box.keyPair();

  const createRes = await fetch(`${BASE_URL}/api/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipientPublicKey: b64(recipient.publicKey) }),
  });
  if (!createRes.ok) throw new Error(`create-link failed: ${createRes.status}`);
  const { slug, codewords } = await createRes.json();
  if (!Array.isArray(codewords) || codewords.length === 0) {
    throw new Error("create-link response missing codewords");
  }
  console.log(`created link ${slug} (codewords: ${codewords.join(" ")})`);

  const plaintext = new TextEncoder().encode("e2ee-drop verification payload");
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(plaintext, nonce, recipient.publicKey, sender.secretKey);

  const uploadUrlRes = await fetch(`${BASE_URL}/api/links/${slug}/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      senderPublicKey: b64(sender.publicKey),
      message: "verification run",
      metadata: {
        fileName: "verify.txt",
        fileSize: plaintext.length,
        nonce: b64(nonce),
        mimeType: "text/plain",
        contentMD5: b64(nacl.hash(encrypted)),
      },
    }),
  });
  if (!uploadUrlRes.ok) throw new Error(`upload-url failed: ${uploadUrlRes.status}`);
  const { dropId, uploadUrl } = await uploadUrlRes.json();

  const putRes = await fetch(uploadUrl, { method: "PUT", body: encrypted });
  if (!putRes.ok) throw new Error(`PUT to storage failed: ${putRes.status}`);

  const completeRes = await fetch(`${BASE_URL}/api/links/${slug}/drops/${dropId}/complete`, {
    method: "POST",
  });
  if (!completeRes.ok) throw new Error(`upload-complete failed: ${completeRes.status}`);

  const downloadUrlRes = await fetch(`${BASE_URL}/api/links/${slug}/download-url`);
  if (!downloadUrlRes.ok) throw new Error(`download-url failed: ${downloadUrlRes.status}`);
  const info = await downloadUrlRes.json();

  const fileRes = await fetch(info.downloadUrl);
  const downloadedBytes = new Uint8Array(await fileRes.arrayBuffer());

  const decrypted = nacl.box.open(
    downloadedBytes,
    fromB64(info.nonce),
    fromB64(info.senderPublicKey),
    recipient.secretKey
  );
  if (!decrypted) throw new Error("decryption failed");
  const text = new TextDecoder().decode(decrypted);
  if (text !== "e2ee-drop verification payload") throw new Error(`unexpected content: ${text}`);

  console.log("OK: full anonymous drop round-trip succeeded");
}

main().catch((err) => {
  console.error("VERIFICATION FAILED:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Build and start the full stack**

Run: `cp .env.example .env && docker compose up -d --build`
Expected: all six services (`postgres`, `minio`, `migrate`, `api`, `cleanup`, `web`) start; `docker compose ps` shows `migrate` exited with code 0 and the rest `running`/`healthy`.

- [ ] **Step 4: Wait for the API to be healthy**

Run: `until curl -sf http://localhost:8080/api/health; do sleep 1; done`
Expected: eventually prints `{"status":"ok"}`.

- [ ] **Step 5: Run the verification script**

Run: `pnpm install && node scripts/verify-e2e.mjs`
Expected: prints `created link <slug>` then `OK: full anonymous drop round-trip succeeded`, exits 0.

- [ ] **Step 6: Tear down**

Run: `docker compose down`
Expected: all containers stop cleanly.

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-e2e.mjs package.json pnpm-lock.yaml
git commit -m "test: add full-stack anonymous drop verification script"
```
