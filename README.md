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

When changing the "change-me" values, keep `MINIO_ACCESS_KEY` /
`MINIO_SECRET_KEY` identical to `MINIO_ROOT_USER` /
`MINIO_ROOT_PASSWORD`, and keep the password inside `DATABASE_URL`
identical to `POSTGRES_PASSWORD` (see the table below).

## Environment variables

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | — (required) | host-side tooling only (`pnpm --filter db`, `pnpm -r test`) | Postgres connection string. **Not read by `docker compose up`**: the `api`/`migrate`/`cleanup` containers build their own Postgres URL internally from `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` against the `postgres` service directly, so editing this value has no effect on the containers — it only matters for host-side processes, which should point at `localhost` (the compose-published Postgres port) rather than the `postgres` hostname |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | — (required) | `postgres`, and indirectly `api`/`migrate`/`cleanup` (their `DATABASE_URL` is built from these) | Postgres container credentials, must match `DATABASE_URL` |
| `PORT` | `3000` | `api` | Port the Fastify server listens on inside its container. Not freely changeable: `apps/web/nginx.conf` hardcodes `proxy_pass http://api:3000`, so changing `PORT` without also editing that file breaks the web → api proxy |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | — (required) | `minio` | MinIO admin credentials |
| `MINIO_ENDPOINT` | — (required) | host-side tooling only | **Not read by `docker compose up`**: the `api`/`cleanup` containers hardcode `http://minio:9000` (the compose-internal MinIO hostname) directly in `docker-compose.yml`, so editing this value has no effect on the containers. It only matters for host-side tooling that talks to MinIO directly — note `docker-compose.yml` publishes no host port for `minio`, so that means a separate, standalone MinIO instance, not the one `docker compose up` starts |
| `MINIO_PUBLIC_ENDPOINT` | `http://localhost:8080/s3` | `api` | Browser-reachable endpoint embedded in presigned upload/download URLs. The `web` service proxies its `/s3/` route through to MinIO, so this must stay in sync with how users actually reach `web` (i.e. with `WEB_PORT` below). If you point it at a different origin (e.g. an external S3 endpoint), also add that origin to `connect-src` in `apps/web/nginx.conf`'s Content-Security-Policy, or the browser will block uploads and downloads |
| `MINIO_REGION` | `us-east-1` | `api`, `cleanup` | S3 region (MinIO ignores the value but the SDK requires one) |
| `MINIO_BUCKET` | — (required) | `api`, `cleanup` | Bucket used for encrypted file storage |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | — (required) | `api`, `cleanup` | Credentials the API uses to sign presigned URLs. **Must equal `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`** — nothing provisions a separate MinIO user, so these are the root credentials under another name |
| `MAX_FILE_SIZE_BYTES` | `524288000` (500 MB) | `api` | Largest file a sender may upload. Uploads pass through `web`'s `/s3/` proxy, which has a static `client_max_body_size 550m` in `apps/web/nginx.conf`; raising this above ~500 MiB also requires raising that nginx setting, or large uploads are rejected at the proxy |
| `LINK_EXPIRY_HOURS` | `24` | `api` | How long an anonymous/one-time link stays valid before it's swept |
| `DROP_RETENTION_DAYS_DEFAULT` | `1` | `api`, `cleanup` | Default max age for an undownloaded drop on a permanent link before it's purged, when the link doesn't set its own retention |
| `DROP_RETENTION_DAYS_MAX` | `7` | `api`, `cleanup` | Upper bound on the per-link retention a permanent link may set, overriding `DROP_RETENTION_DAYS_DEFAULT` |
| `CODEWORD_WORD_COUNT` | `4` | `api` | Number of words in a link's verification phrase (sender/recipient read these aloud to confirm they have the right link). Each word is one byte of a hash, so N words give 256^N possible phrases; minimum enforced is 4 (~4.3 billion), which keeps the chance of two unrelated, simultaneously active links coincidentally sharing a phrase small even into the thousands of concurrently active links. This is a probabilistic bound, not a hard uniqueness guarantee — an attacker or typo hitting one *specific* link's phrase is a separate, much smaller 1-in-256^N odds regardless of this setting |
| `SESSION_SECRET` | — (required) | `api`, `cleanup` | Signs the httpOnly session cookie |
| `APP_SECRET_KEY` | — (required) | `api`, `cleanup` | Encrypts stored TOTP secrets at rest |
| `ALLOW_REGISTRATION` | `true` | `api`, `cleanup` | Set to `false` to close self-registration on this instance |
| `DEFAULT_STORAGE_QUOTA_BYTES` | `5368709120` (5 GiB) | `api`, `cleanup` | Default per-account storage quota for new accounts |
| `APP_URL` | `http://localhost:8080` | `api`, `cleanup` | Public base URL: used when building links in emails, and to decide whether the session cookie is sent as `Secure` (only when this starts with `https://`). Must be a valid `http://` or `https://` URL — an invalid value stops the API from starting |
| `TRUST_PROXY_HOPS` | `1` | `api` | How many reverse-proxy hops in front of the API are trusted when reading the client IP from `X-Forwarded-For` (used to rate-limit login attempts per IP). `1` = the shipped `web` (nginx) container only. Set to `2` if you put your own reverse proxy in front of `web`; see [Fronting with TLS](#fronting-with-tls) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — (optional) | `api`, `cleanup` | Outgoing mail for email verification and password-reset requests; those flows are unavailable if unset |
| `WEB_PORT` | `8080` | `web` | Host port the `web` service (SPA + `/api` + `/s3` proxy) is published on — this is the port you visit in a browser |

**Defaults only apply to variables that are truly unset.** Most
variables above are passed in `docker-compose.yml` as `VAR: ${VAR}`
(only `WEB_PORT` and `MINIO_PUBLIC_ENDPOINT` carry compose-level `:-`
fallbacks; `DATABASE_URL` and `MINIO_ENDPOINT` are the other exceptions —
for `api`/`migrate`/`cleanup` they're built from other vars or hardcoded
to compose-internal hostnames instead of passed through, per the table
above), and docker compose passes a variable that is missing or
blank in `.env` as an *empty string*, not as unset. The numeric
variables happen to treat an empty string as "use the default", but
others do not: a blank `ALLOW_REGISTRATION` silently *closes*
registration (only the exact string `true` enables it), and a blank
`MINIO_REGION` stays empty instead of falling back to its default.
(`APP_URL` is an exception: a blank value now falls back to its
default rather than staying empty, and an invalid one stops the API
from starting — see the table above.) Either give each variable a
real value in `.env` (as
`.env.example` does), or remove its line from `docker-compose.yml`'s
`environment:` block if you want the coded default.

## Fronting with TLS

`docker-compose.yml` does not include a reverse proxy or TLS
termination — it publishes the `web` service on a plain HTTP port and
expects you to put your own reverse proxy (Caddy, Traefik, nginx-proxy,
etc.) in front of it for a real domain and HTTPS, the same way you
would for Immich or Vaultwarden. Point your proxy at the `web`
service's published port.

**Set `APP_URL` to your real `https://` origin in `.env` when you do
this.** The API decides whether to send the session cookie as `Secure`
by checking whether `APP_URL` starts with `https://` — it has no other
way to know your proxy terminates TLS in front of it. Leaving `APP_URL`
as the shipped `http://localhost:8080` default means every session
cookie is sent without `Secure`, even once your domain is genuinely
served over HTTPS.

**Set `TRUST_PROXY_HOPS=2` in `.env` when you do this.** The API
limits login attempts per client IP address, and it works out the
client IP by trusting a fixed number of proxy hops in the
`X-Forwarded-For` header. The default, `1`, fits the shipped setup,
where the `web` container's nginx is the only proxy. Your own proxy
adds a second hop (client → your proxy → `web`/nginx → `api`). If you
leave the value at `1`, the API sees every user as coming from your
proxy's address, so they all share one rate-limit bucket, and a single
client making a few bad login attempts can lock everyone out of
logging in. Add one more for each additional proxy layer (for example,
a CDN in front of your proxy). Setting it higher than your real number
of proxies lets clients fake their IP, so don't overshoot.

Your proxy must also append the client address to `X-Forwarded-For`.
Caddy's `reverse_proxy` and Traefik do this by default. With plain
nginx, add `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.

Never publish the `api` service's port or otherwise let clients reach
the API directly. The shipped `docker-compose.yml` publishes no ports
for `api`, so only `web` can talk to it. The API trusts whatever
connects to it directly as a proxy, so a client that reached it
directly could put any address it likes in `X-Forwarded-For`.

**When `TRUST_PROXY_HOPS` is `2` or higher, the same reasoning applies
to `web`'s own published port.** The shipped `docker-compose.yml`
publishes `web` on `${WEB_PORT:-8080}` across all interfaces by
default, so if your host is reachable from the internet, that port
usually is too — even once your own reverse proxy is also pointed at
it. A client that reaches `web` directly, bypassing your proxy, is
then one fewer hop away than the API expects, so `TRUST_PROXY_HOPS`
trusts an `X-Forwarded-For` value the client supplied itself: they can
either fake a new IP on every login attempt (defeating the per-IP
rate limit entirely) or put a real victim's IP in the header to lock
that person out of logging in — the same spoofing risk the paragraph
above describes for `api`, one hop further out. Make sure `web`'s port
is reachable *only* from your own reverse proxy once you've set
`TRUST_PROXY_HOPS` above `1` — for example, bind it to loopback
(`WEB_PORT=127.0.0.1:8080` in `.env`, or a compose override) if your
proxy runs on the same host, put both containers on a private Docker
network your proxy also joins, or block the port at your firewall for
everything except your proxy's own address.

## Development

Each workspace package has its own `dev`/`test` scripts; see
`package.json` at the repo root and in `apps/api`, `apps/web`,
`packages/db`, `packages/shared`. Run `pnpm -r test` to run every
package's test suite, and `pnpm lint:i18n` to verify the `en`/`nb`
locale files stay in sync.
