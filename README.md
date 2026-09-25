# e2ee-drop

Self-hosted, end-to-end encrypted file drops. A recipient creates a
link — no account needed, or a permanent link tied to an account — and
a sender uploads a file to that link, encrypted in their browser before
it ever leaves their machine. The server brokers presigned upload/
download URLs against its own MinIO storage and never sees plaintext
file bytes, the file's ciphertext, or anyone's private key — only the
recipient's browser can decrypt what was sent to them.

## Quickstart

```bash
cp .env.example .env
# edit .env: at minimum change every "change-me" value
docker compose up -d --build
```

The app is served on `http://localhost:8080` (see `docker-compose.yml`
and the `WEB_PORT` variable below to change the published port).
`docker compose ps` should show `migrate` exited with code 0 and the
rest of the services running.

## Environment variables

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | — (required) | `api`, `migrate`, `cleanup` | Postgres connection string |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | — (required) | `postgres` | Postgres container credentials, must match `DATABASE_URL` |
| `PORT` | `3000` | `api` | Port the Fastify server listens on inside its container |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | — (required) | `minio` | MinIO admin credentials |
| `MINIO_ENDPOINT` | — (required) | `api`, `cleanup` | Internal MinIO endpoint, reachable inside the compose network — used by `api`/`cleanup` for direct calls (bucket setup, deletes) |
| `MINIO_PUBLIC_ENDPOINT` | `http://localhost:8080/s3` | `api` | Browser-reachable endpoint embedded in presigned upload/download URLs. The `web` service proxies its `/s3/` route through to MinIO, so this must stay in sync with how users actually reach `web` (i.e. with `WEB_PORT` below) |
| `MINIO_REGION` | `us-east-1` | `api`, `cleanup` | S3 region (MinIO ignores the value but the SDK requires one) |
| `MINIO_BUCKET` | — (required) | `api`, `cleanup` | Bucket used for encrypted file storage |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | — (required) | `api`, `cleanup` | Credentials the API uses to sign presigned URLs |
| `MAX_FILE_SIZE_BYTES` | `524288000` (500 MB) | `api` | Largest file a sender may upload |
| `LINK_EXPIRY_HOURS` | `24` | `api` | How long an anonymous/one-time link stays valid before it's swept |
| `DROP_RETENTION_DAYS` | `7` | `api`, `cleanup` | Default max age for an undownloaded drop on a permanent link before it's purged; overridable per link |
| `SESSION_SECRET` | — (required once accounts are enabled) | `api`, `cleanup` | Signs the httpOnly session cookie |
| `APP_SECRET_KEY` | — (required once accounts are enabled) | `api`, `cleanup` | Encrypts stored TOTP secrets at rest |
| `ALLOW_REGISTRATION` | `true` | `api`, `cleanup` | Set to `false` to close self-registration on this instance |
| `DEFAULT_STORAGE_QUOTA_BYTES` | `5368709120` (5 GiB) | `api`, `cleanup` | Default per-account storage quota for new accounts |
| `APP_URL` | `http://localhost:8080` | `api`, `cleanup` | Public base URL, used when building links in emails |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — (optional) | `api`, `cleanup` | Outgoing mail for email verification and password-reset requests; those flows are unavailable if unset |
| `WEB_PORT` | `8080` | `web` | Host port the `web` service (SPA + `/api` + `/s3` proxy) is published on — this is the port you visit in a browser |

## Fronting with TLS

`docker-compose.yml` does not include a reverse proxy or TLS
termination — it publishes the `web` service on a plain HTTP port and
expects you to put your own reverse proxy (Caddy, Traefik, nginx-proxy,
etc.) in front of it for a real domain and HTTPS, the same way you
would for Immich or Vaultwarden. Point your proxy at the `web`
service's published port.

## Development

Each workspace package has its own `dev`/`test` scripts; see
`package.json` at the repo root and in `apps/api`, `apps/web`,
`packages/db`, `packages/shared`. Run `pnpm -r test` to run every
package's test suite, and `pnpm lint:i18n` to verify the `en`/`nb`
locale files stay in sync.
