# CourseCut Web

Multi-tenant browser version of the CourseCut desktop app. Upload a lecture video, it gets transcribed and split into lessons by AI, then exported as trimmed MP4s.

This file covers **only the web app** (`apps/` + `infra/`). The desktop Tauri app is documented in `README.md` and `docs/PRD.md` and is untouched by any of this.

Planned public name: `coursecut.duckdns.org`, a free DuckDNS subdomain. It is on the Public Suffix List, so it gets its own Let's Encrypt rate limit bucket, which `sslip.io` and `nip.io` do not.

> Note on the filename: the repo root already has a `README.md` for the desktop app, and macOS treats filenames case-insensitively, so this file is `WEB-README.md` to avoid overwriting it.

---

## Repo layout

```
src/, src-tauri/        desktop app. NOT touched by the web port.
apps/
  web/                  Vite + React SPA (copy of the desktop UI)
  api/                  Hono HTTP API, Drizzle schema, migrations
  worker/               ffmpeg + Whisper + GPT job processor
infra/
  postgres/compose.yml  local dev: Postgres + MinIO
  docker/               prod: 4 Dockerfiles, compose.prod.yml, Caddyfile, deploy.sh
docs/
  web-app-plan.md       the full design doc and decision log
  web-deploy-runbook.md operator steps: droplet, DNS, R2, secrets, restore
scripts/ui-drift.sh     flags desktop UI changes not yet ported to web
```

`apps/web`, `apps/api` and `apps/worker` each install their own `node_modules`. The repo root is deliberately **not** an npm workspace, because making it one would change how the shipping desktop app builds.

---

## Architecture

```mermaid
flowchart TB
    B["Browser (React SPA)"]
    C["Caddy<br/>TLS + static + /api proxy"]
    A["apps/api (Hono)<br/>auth, CRUD, presigned URLs,<br/>enqueue, SSE"]
    P[("Postgres 16<br/>data + job queue")]
    W["apps/worker<br/>ffmpeg + OpenAI"]
    R[("Cloudflare R2<br/>video, audio, exports")]
    O["OpenAI<br/>Whisper + GPT-5.5"]

    B -->|https| C
    C --> A
    A <-->|SQL + LISTEN/NOTIFY| P
    W <-->|poll queue, write results| P
    B <==>|"PUT / GET presigned<br/>(video bytes, direct)"| R
    W <==> R
    W -->|audio + transcript text only| O
    A -.->|SSE progress| B
```

Key points:

* **Video bytes never pass through the API or Caddy.** The browser talks straight to R2 with presigned URLs. The API only mints those URLs.
* **The job queue is Postgres** (graphile-worker). No Redis.
* **Progress is SSE**, published over Postgres `LISTEN`/`NOTIFY` so the worker (a separate process, later a separate box) can push to a browser connected to the API.
* **One origin.** Caddy serves the SPA and proxies `/api`, so the session cookie is a plain first-party httpOnly cookie. No CORS, no `SameSite=None`.

### Upload and processing flow

```mermaid
sequenceDiagram
    participant U as Browser
    participant A as API
    participant R as R2
    participant Q as Postgres queue
    participant W as Worker
    participant O as OpenAI

    U->>A: POST /projects/:id/uploads (name, size)
    A->>A: check quota (claimed size)
    A-->>U: ticket {single url} or {multipart, part_size, part_count}
    U->>R: PUT bytes directly (parts signed in batches)
    U->>A: POST /videos/:id/complete
    A->>R: HeadObject (verify real size)
    A->>A: re-check quota, record size_bytes
    A->>Q: enqueue extract:<video>
    A-->>U: 202

    W->>Q: pick up extract
    W->>R: GET source video
    W->>W: ffmpeg extract audio (24kbps Opus)
    W->>R: PUT audio
    W->>Q: enqueue transcribe
    W->>O: Whisper (audio only)
    W->>O: GPT-5.5 (transcript text only)
    W->>Q: write lessons, NOTIFY progress
    A-->>U: SSE progress events throughout
```

Export is the same shape: `POST /exports` enqueues, the worker cuts and joins segments with ffmpeg, uploads the MP4 to R2, and the UI hands back a presigned download URL.

---

## Stack

| Concern | Choice | Why |
|---|---|---|
| Frontend | Vite + React 18 SPA, Tailwind 4, shadcn/radix | Same components as desktop, so views copy over unchanged |
| API | Hono on Node 22, run through `tsx` | Small, TypeScript first, no build step in the image |
| Auth | `better-auth` + organization plugin | Sessions, password hashing, orgs, invites. No custom crypto |
| Database | Plain Postgres 16 | Supabase was dropped, the API already did most of what it bundles |
| ORM / migrations | Drizzle + drizzle-kit | Types line up with what `db.ts` already declared |
| Queue | graphile-worker (Postgres backed) | One less service to run and back up |
| Progress | SSE over `LISTEN`/`NOTIFY` | One directional, no websocket layer needed |
| Object storage | Cloudflare R2 (MinIO locally) | Zero egress. This product moves far more bytes than it stores |
| Media | ffmpeg 7.1 pinned in the worker image | Same pipeline as desktop |
| AI | OpenAI `whisper-1` + `gpt-5.5` | Same as desktop, but on a platform key |
| Gateway | Caddy | Automatic Let's Encrypt TLS, SPA + API on one origin |
| Registry | ghcr.io | No account or long lived token to create |
| Compute | One DigitalOcean droplet | CPU and RAM where it is cheap, bytes where they are cheap |

---

## Decisions that matter

| Decision | Rejected | Reason |
|---|---|---|
| Web app is an exact **port** of the desktop UI | A redesign | The two must stay the same product |
| `apps/web` holds its **own copy** of the UI | Shared `packages/ui` | Extracting shared UI rewrites a shipping app's build. Drift is guarded by `scripts/ui-drift.sh` instead |
| Cloudflare R2 for storage | DO Spaces, AWS S3 | Egress dominates cost at roughly 4:1 read to store. 1TB stored + 5TB egress is about $15/mo on R2 vs $60 on Spaces vs $465 on S3 |
| Postgres RLS on top of app scoping | App scoping only | One forgotten `WHERE` would be a cross tenant leak |
| **Platform owned OpenAI key** | Bring your own key (desktop behaviour) | Web users do not bring a key. Cost is ours, which is why quotas exist |
| Vite SPA | Next.js | App Router pushes toward RSC and a view tree rewrite |
| Caddy as the gateway | nginx, Traefik, a bare Node server | Automatic Let's Encrypt TLS with no cert plumbing, and it puts the SPA and the API on one origin |
| Postgres queue | Redis / BullMQ | No capability gained at this scale |
| Uploads bypass the API | Proxy through the API | Multi GB video through one droplet is wasted bandwidth and RAM |

**Caddy and Next.js are not alternatives to each other.** Caddy is the web server and reverse proxy, Next.js would have been the frontend framework. Next.js was rejected in favour of a Vite SPA because the App Router pushes copied views toward server components and a restructure, which would have turned a mechanical port into a rewrite. Something still has to terminate TLS and serve static files in front of whatever the frontend is, and that is Caddy either way.

### Where the web app deliberately differs from desktop

The desktop app's rule is "video never leaves the device". Cloud transcoding breaks that, on purpose. These are the only sanctioned differences:

| # | Desktop | Web |
|---|---|---|
| D1 | Native file dialog, files stay in place | Browser picker, presigned PUT to R2 |
| D2 | Playback from local path | Short lived presigned GET URL |
| D3 | Calls return when work is done | Calls enqueue and return a job id |
| D4 | Progress on a Tauri event channel | Same shape, SSE transport |
| D5 | Export writes to a chosen folder | Export lands in R2, UI offers a download |
| D6 | Reveal in Finder / Explorer | Download link |
| D7 | User's OpenAI key in the OS keychain | Platform key in the API env, **no key UI at all** |
| D8 | No login, single local user | Sessions, orgs, memberships |

Everything else (views, navigation, breadcrumbs, keyboard shortcuts, lesson cards, scrubber, AI edit prompt, dark theme) is identical.

---

## Data model

Postgres port of the desktop SQLite schema, plus the multi-tenant layer. Defined in `apps/api/src/db/schema.ts`, migrations in `apps/api/drizzle/`.

**Auth tables (owned by better-auth):** `users`, `sessions`, `accounts`, `verifications`, `organizations`, `members`, `invitations`.

**App tables:** `projects`, `videos`, `transcript_segments`, `lessons`, `lesson_segments`, `exports`, `jobs`, `org_settings`, `usage_events`.

Conventions:

* Ids are `text`, not `uuid`, because better-auth mints non-UUID ids.
* **Every tenant table carries `org_id` directly**, so a policy is a single column check. Children reference `(parent_id, org_id)` composite foreign keys, so a child whose org drifts from its parent's is unrepresentable.
* `videos.storage_key` and `exports.output_key` hold keys like `{org}/{project}/{video}/source.mp4`. **Never a bucket hostname.** That keeps a move off R2 a config change.
* `usage_events` is append only with **no foreign key to videos**, so deleting a video cannot refund the month.

### Tenant isolation (the important bit)

```
request  ->  withOrg(orgId)  ->  BEGIN
                                 set_config('app.current_org_id', $1, true)
                                 ... queries ...
                                 COMMIT
```

* RLS policies on every tenant table check `org_id = current_setting('app.current_org_id', true)`.
* The `true` (missing_ok) means an unset org yields NULL, and `org_id = NULL` is never true, so a query that skipped `withOrg()` returns **nothing**. Fail closed.
* The API connects as a role with **no `BYPASSRLS` and no table ownership**. Migrations use a separate privileged role. Every tenant table is `FORCE`d.
* `apps/api/test/tenant-isolation.test.ts` deliberately writes the forgotten scoping bug and asserts it comes back empty. It runs in CI against a real Postgres.

---

## API surface

All under `/api`, session cookie authenticated, org scoped.

```
GET    /api/health                          GET  /api/config
GET    /orgs                                GET  /usage
GET    /projects                            POST /projects
GET    /projects/:id                        DELETE /projects/:id
GET    /projects/:id/videos                 GET  /projects/:id/exports
POST   /projects/:id/uploads                POST /videos/:id/upload/part-urls
POST   /videos/:id/complete                 POST /videos/:id/upload/abort
POST   /videos/:id/extract                  POST /videos/:id/transcribe
POST   /videos/:id/analyze                  POST /videos/:id/error
GET    /videos/:id                          DELETE /videos/:id
GET    /videos/:id/transcript               PATCH /transcript-segments/:id
POST   /videos/playback-url
GET    /videos/:id/lessons                  POST /videos/:id/lessons
PUT    /videos/:id/lesson-order             PATCH /lessons/:id
DELETE /lessons/:id                         POST /lessons/merge
POST   /lessons/:id/split                   POST /lessons/:id/segments
GET    /lessons/:id/segments                PUT  /lessons/:id/segment-order
PATCH  /lesson-segments/:id                 DELETE /lesson-segments/:id
POST   /lessons/:id/segment-edit/preview    POST /lessons/:id/segment-edit/apply
POST   /exports                             POST /exports/download-url
GET    /settings/analysis-instructions      PUT  /settings/analysis-instructions
GET    /progress                            (SSE stream)
```

Status codes worth knowing: **402** means a quota was hit (retrying will never work), **429** means rate limited (retrying will work).

---

## Credentials

### Postgres login

| | Local development | Production |
|---|---|---|
| Host | `localhost` | `postgres` (compose network name, **not** localhost) |
| Port | `55432` on this machine, `5432` by default | `5432`, **not published to the host at all** |
| Database | `coursecut` | `coursecut` |
| Superuser / admin role | `postgres` / `postgres` | `postgres` / value of `POSTGRES_PASSWORD` |
| App role | `coursecut_app` / `coursecut_app_dev` | `coursecut_app` / value of `APP_DB_PASSWORD` |

Connect locally:

```sh
psql postgres://postgres:postgres@localhost:55432/coursecut          # admin
psql postgres://coursecut_app:coursecut_app_dev@localhost:55432/coursecut   # app role, RLS applies
```

### Production database in the browser

**https://db.coursecut.duckdns.org** is Adminer, a browser SQL client for the live database. Two logins, in order:

**1. Basic auth**, the browser popup that appears first:

| | |
|---|---|
| Username | `DB_UI_USER` in `/opt/coursecut/db-ui.env` (currently `admin`) |
| Password | the plaintext whose bcrypt hash is `DB_UI_PASSWORD_HASH` in the same file — not recoverable from it, so keep it in your password manager |

**2. Adminer's own form**, which is the actual database login:

| Field | Value |
|---|---|
| System | PostgreSQL |
| Server | `postgres` (prefilled, it is the container name, not an IP) |
| Username | `postgres` |
| Password | the value of `POSTGRES_PASSWORD` in `/opt/coursecut/.env` |
| Database | `coursecut` |

Log in as `postgres` and you see every org's rows at once, because RLS does not apply to the admin role. Use `coursecut_app` with `APP_DB_PASSWORD` instead if you want to see what a tenant-scoped connection sees, though it returns nothing until an org is pinned to the transaction.

Adminer stores no credentials. It is reachable only through Caddy, publishes no port of its own, and the basic auth is checked before a request ever reaches it. That still leaves it the largest piece of attack surface in the stack, so if you stop using it, comment the `db.` block out of the `Caddyfile` and drop the `adminer` service.

### Production database over SSH

No extra service, nothing exposed. This is the safer path:

```sh
ssh -i ~/.ssh/coursecut_deploy deploy@134.209.150.195
cd /opt/coursecut
docker compose -f compose.prod.yml exec postgres psql -U postgres coursecut
```

Note the key is `coursecut_deploy` for user `deploy`. The other key, `coursecut_admin`, works only for `root`.

One-liner without the interactive session:

```sh
ssh -i ~/.ssh/coursecut_deploy deploy@134.209.150.195 \
  "cd /opt/coursecut && docker compose -f compose.prod.yml exec -T postgres \
   psql -U postgres coursecut -c 'select email, created_at from users order by created_at desc;'"
```

Two roles, always. `postgres` owns the tables and runs migrations. `coursecut_app` serves every request, has **no `BYPASSRLS`** and owns nothing, which is what makes row level security real. Never serve a request with the admin URL, every policy silently stops applying.

Port `5432` on this machine is held by another project's `bms-postgres` container, so local Postgres runs on `55432`.

### Other logins

| What | Value |
|---|---|
| MinIO root (local S3) | `coursecut` / `coursecut_dev_secret` |
| MinIO S3 endpoint | `http://localhost:9000`, console `http://localhost:9001` |
| MinIO bucket | `coursecut` |
| Seeded app login A | `ada@example.com` / `coursecut-dev-password` (member of both orgs) |
| Seeded app login B | `grace@example.com` / `coursecut-dev-password` (Globex only) |
| Seeded orgs | `org_acme` (Acme University), `org_globex` (Globex Institute) |
| API | `http://localhost:3000` |
| SPA | `http://localhost:5173` (Vite proxies `/api` to :3000) |
| Cloudflare account | `Prashantnayak9999@gmail.com`, not the session login email |
| Registry | `ghcr.io/urperfectdude`, no login to create |
| Live app | https://coursecut.duckdns.org |
| Live DB UI | https://db.coursecut.duckdns.org |
| Droplet | `134.209.150.195`, SSH as `deploy` with `~/.ssh/coursecut_deploy` |

There is **no seeded user in production**. The first real account signs up in the browser.

---

## Every environment variable

Three files hold them: `apps/api/.env` (also read by the worker), `apps/web/.env`, and `/opt/coursecut/.env` on the droplet. The last one is created by hand, `chmod 600`, and is the only place production secrets exist. The deploy pipeline never writes it.

### apps/api/.env (API and worker, current local values)

```sh
DATABASE_URL=postgres://coursecut_app:coursecut_app_dev@localhost:55432/coursecut
DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:55432/coursecut
APP_DB_USER=coursecut_app
APP_DB_PASSWORD=coursecut_app_dev

APP_URL=http://localhost:5174
PORT=3000
AUTH_SECRET=dev_only_not_a_secret_change_me_0123456789

S3_ENDPOINT=http://localhost:9000
S3_REGION=auto
S3_BUCKET=coursecut
S3_ACCESS_KEY_ID=coursecut
S3_SECRET_ACCESS_KEY=coursecut_dev_secret
S3_FORCE_PATH_STYLE=true

OPENAI_API_KEY=sk-proj-…            # your own key, never the platform one
```

> **No real credential belongs in this file** — it is committed, like every
> other `.md` here. Live values live in `/opt/coursecut/.env` and
> `/opt/coursecut/db-ui.env` on the droplet, and nowhere else. An earlier draft
> pasted the platform OpenAI key, the Postgres superuser password and the
> Adminer password in full; they were removed before this file was ever
> committed, so they are not in git history.

`APP_URL` is `5174` here only because another project holds `5173`. It must match wherever the SPA actually runs, since better-auth uses it as the trusted origin and to build reset links.

### apps/web/.env

```sh
VITE_API_MODE=live      # anything else in dev uses the in-memory mock
# VITE_API_BASE=/api    # only if the API is not behind the Vite proxy
```

Production builds are always live. The mock sits behind `import.meta.env.DEV` and is dynamically imported, so it is not in the production bundle.

### infra/postgres/compose.yml (local containers)

| Variable | Value | Note |
|---|---|---|
| `POSTGRES_USER` | `postgres` | fixed in the compose file |
| `POSTGRES_PASSWORD` | `postgres` | dev only, bound to 127.0.0.1 |
| `POSTGRES_DB` | `coursecut` | |
| `POSTGRES_PORT` | `55432` here, `5432` default | host port override |
| `MINIO_ROOT_USER` | `coursecut` | |
| `MINIO_ROOT_PASSWORD` | `coursecut_dev_secret` | |
| `MINIO_API_CORS_ALLOW_ORIGIN` | `http://localhost:5173` | MinIO has no per bucket CORS, so it is server wide |
| `MINIO_PORT` | `9000` | S3 API |
| `MINIO_CONSOLE_PORT` | `9001` | web console |

Run with `POSTGRES_PORT=55432 docker compose -f infra/postgres/compose.yml up -d --wait`.

### /opt/coursecut/.env (production, full list)

| Variable | Production value | Used by | Required |
|---|---|---|---|
| `REGISTRY` | `ghcr.io/urperfectdude` | compose | yes |
| `IMAGE_TAG` | 12 char commit SHA, rewritten by `deploy.sh` | compose | yes |
| `APP_DOMAIN` | `coursecut.duckdns.org` | caddy | yes |
| `APP_URL` | `https://coursecut.duckdns.org` | api | yes, must match `APP_DOMAIN` |
| `ACME_EMAIL` | your email | caddy | **yes**, blank is a Caddyfile syntax error that takes the site down |
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` | postgres | yes |
| `APP_DB_USER` | `coursecut_app` | migrate | default `coursecut_app` |
| `APP_DB_PASSWORD` | `openssl rand -hex 32` | migrate | yes, must match the password inside `DATABASE_URL` |
| `DATABASE_URL` | `postgres://coursecut_app:<APP_DB_PASSWORD>@postgres:5432/coursecut` | api, worker | yes |
| `DATABASE_ADMIN_URL` | `postgres://postgres:<POSTGRES_PASSWORD>@postgres:5432/coursecut` | migrate only | yes |
| `PORT` | `3000` | api | default `3000` |
| `AUTH_SECRET` | `openssl rand -base64 48` | api | yes, rotating it signs everyone out |
| `OPENAI_API_KEY` | the platform key | api, worker | yes, worker refuses to boot without it |
| `OPENAI_BASE_URL` | unset | api, worker | default `https://api.openai.com/v1` |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | api, worker | yes, no bucket in the hostname |
| `S3_REGION` | `auto` | api, worker | default `auto` |
| `S3_BUCKET` | `coursecut-media` | api, worker | yes |
| `S3_ACCESS_KEY_ID` | R2 token id, media bucket only | api, worker | yes |
| `S3_SECRET_ACCESS_KEY` | R2 token secret, shown once | api, worker | yes |
| `S3_FORCE_PATH_STYLE` | `false` | api, worker | R2 does not need it, MinIO does |
| `S3_URL_TTL_SECONDS` | `3600` | api | default `3600` |
| `FFMPEG_PATH` | unset, pinned in the image | worker | default `ffmpeg` |
| `FFPROBE_PATH` | unset, pinned in the image | worker | default `ffprobe` |
| `WORKER_SCRATCH_DIR` | `/var/lib/coursecut/scratch` | worker | default `/tmp/coursecut-worker` |
| `WORKER_CPUS` | `0.8` | compose | default `0.8` |
| `DB_DOMAIN` | `db.coursecut.duckdns.org` | caddy | yes, Caddy gets its own cert for it |
| `DB_UI_USER` | `admin` | caddy | in `db-ui.env`, not `.env` |
| `DB_UI_PASSWORD_HASH` | bcrypt, **every `$` doubled to `$$`** | caddy | in `db-ui.env`, not `.env` |
| `QUOTA_TRANSCRIPTION_MINUTES_PER_MONTH` | `600` | api | default `600` |
| `QUOTA_STORAGE_BYTES` | `53687091200` (50 GiB) | api | default 50 GiB |
| `QUOTA_MAX_UPLOAD_BYTES` | `5368709120` (5 GiB) | api | default 5 GiB |
| `QUOTA_MAX_ACTIVE_JOBS` | `25` | api | default `25` |
| `QUOTA_MAX_ORGS_PER_USER` | `3` | api | default `3` |
| `RETENTION_EXPORT_DAYS` | `14` | api, worker | default `14` |
| `RETENTION_SOURCE_DAYS` | `0` (never expire) | api, worker | default `0` |
| `RETENTION_PENDING_UPLOAD_HOURS` | `24` | api, worker | default `24` |
| `RETENTION_ORPHAN_GRACE_HOURS` | `24` | api, worker | default `24` |
| `RETENTION_SWEEP_CRON` | `20 4 * * *` | worker | default `20 4 * * *`, UTC |
| `MAIL_DRIVER` | `none`, or `log`, or `resend` | api | default `none`, which means no password reset at all |
| `MAIL_FROM` | `CourseCut <no-reply@coursecut.duckdns.org>` | api | default `CourseCut <no-reply@localhost>` |
| `MAIL_API_KEY` | Resend key | api | only with `resend` |
| `MAIL_API_URL` | `https://api.resend.com/emails` | api | default is Resend |
| `BACKUP_DATABASE_URL` | `postgres://postgres:<POSTGRES_PASSWORD>@postgres:5432/coursecut` | backup | yes |
| `BACKUP_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | backup | yes |
| `BACKUP_S3_BUCKET` | `coursecut-backups` | backup | yes |
| `BACKUP_S3_ACCESS_KEY_ID` | a **second** R2 token id | backup | yes |
| `BACKUP_S3_SECRET_ACCESS_KEY` | a **second** R2 token secret | backup | yes |
| `BACKUP_S3_REGION` | `auto` | backup | default `auto` |
| `BACKUP_S3_PREFIX` | `postgres` | backup | default `postgres` |
| `BACKUP_RETENTION_DAYS` | `30` | backup | default `30` |
| `BACKUP_HOUR_UTC` | `03` | backup | default `03` |

Rules that bite if you get them wrong:

* **Hostnames are container names, not `localhost`.** `postgres` is the database host inside compose.
* **Compose interpolates `env_file` values too.** Any `$` in a value has to be written `$$`. This bit the bcrypt hash for the DB UI: stored literally, `$2a$14$SG9…` reached Caddy as `$2a$14.6B.`, and every password was rejected in a way that looked like a wrong password. Verify with `docker compose -f compose.prod.yml exec caddy printenv DB_UI_PASSWORD_HASH`.
* **Use hex, not base64, for the two database passwords.** They sit inside `postgres://` URLs where base64's `+ / =` are reserved or mangled, and the symptom is an auth failure with a password that looks correct. `AUTH_SECRET` is not in a URL, so base64 is fine there.
* **`APP_DB_PASSWORD` must equal the password inside `DATABASE_URL`.** Bootstrap sets the role's password from the first, the API connects with the second. A mismatch is an API that starts and then cannot log in to its own database.
* **Comments go above a value, never after it.** `S3_ENDPOINT=  # fill me in` is read as the literal string by some parsers.
* The `backup` container is the only service **not** given `env_file: .env`. It gets its six variables explicitly, so it never holds the OpenAI key or the media bucket credential.

### GitHub Actions secrets (five, none of them an app secret)

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | droplet IP or hostname |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | private half of a CI only ed25519 key |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 <ip>`, verified against the DO console fingerprint |
| `APP_DOMAIN` | public domain, for the post deploy health check |

No registry secret. ghcr.io uses the automatic per run `GITHUB_TOKEN`.

### Cloudflare R2 buckets

| Bucket | Holds | Who has the credential |
|---|---|---|
| `coursecut-media` | source video, extracted audio, exports | api + worker |
| `coursecut-backups` | nightly `pg_dump` output | the backup container only |

Two buckets and two tokens on purpose. If they shared one, an API compromise would take the recovery path with it.

The media bucket needs CORS, or browser uploads fail while `curl` works:

```sh
cd apps/api
npm run storage:cors          # applies GET/PUT/HEAD + ETag for APP_URL's origin
npm run storage:cors -- --show
```

---

## Running it locally

```sh
# 1. Postgres + MinIO
POSTGRES_PORT=55432 docker compose -f infra/postgres/compose.yml up -d --wait

# 2. API
cd apps/api
cp .env.example .env      # then set OPENAI_API_KEY and fix the ports
npm install
npm run db:reset          # bootstrap roles -> migrate -> seed
npm test                  # 85 tests: isolation, contract, pipeline, quotas, openai
npm run dev:api           # :3000

# 3. Worker (needs ffmpeg on PATH, reads apps/api/.env)
cd apps/worker && npm install && npm run dev

# 4. SPA
cd apps/web
cp .env.example .env      # VITE_API_MODE=live
npm install && npm run dev   # :5173
```

Leave `VITE_API_MODE` unset and the SPA uses an in memory mock instead, so the UI is clickable with no backend running. The mock is behind `import.meta.env.DEV` and is not in a production bundle.

Useful commands:

```sh
npm run db:generate       # new Drizzle migration
npm run retention:sweep   # run the nightly collection by hand
npm run org:purge -- <org id> <org id>   # id twice, it is irreversible
npm run auth:generate     # reconcile the better-auth table mapping
../../scripts/ui-drift.sh # desktop UI changes not yet ported
```

---

## Deploying

Four images go to `ghcr.io/urperfectdude/coursecut-{api,worker,web,backup}`, tagged with the 12 character commit SHA.

```mermaid
flowchart LR
    push["push to main<br/>(apps/** or infra/docker/**)"] --> build["build 4 images<br/>linux/amd64"]
    build --> ghcr["ghcr.io"]
    ghcr --> ssh["scp compose.prod.yml,<br/>Caddyfile, deploy.sh"]
    ssh --> run["deploy.sh &lt;sha&gt; on droplet"]
    run --> health["curl https://domain/api/health"]
```

On the droplet, `deploy.sh` rewrites `IMAGE_TAG` in `.env`, pulls, and runs `docker compose up -d --wait`. `--wait` blocks until every healthcheck passes, so a failed deploy fails the command.

Services in `compose.prod.yml`:

| Service | Notes |
|---|---|
| `postgres` | **No published ports.** Reachable only on the compose network |
| `migrate` | One shot, `db:bootstrap && db:migrate`, everything else waits for it. **No seed** |
| `api` | No published ports, Caddy reaches it over the network |
| `worker` | The only one with a scratch volume, capped at `WORKER_CPUS` (0.8) |
| `caddy` | 80, 443, 443/udp. TLS and the SPA |
| `backup` | Nightly `pg_dump` at 03:00 UTC to the backup bucket, 30 day retention |

First deploy checklist (full version in `docs/web-deploy-runbook.md`):

1. Run `infra/docker/bootstrap-droplet.sh` (deploy user, Docker, ufw 22/80/443, fail2ban). Rotate the root password in the DO console and restart sshd yourself only after proving key auth works.
2. Point DNS at the droplet **before** the first deploy, or Caddy burns a Let's Encrypt attempt.
3. Create the two R2 buckets and their two scoped tokens, then apply CORS.
4. Fill `/opt/coursecut/.env` on the droplet. Comments go **above** a value, never after it.
5. Push to main.

There is no seeded user in production. The first real account signs up in the browser and lands on the create organization screen.

**Rollback:** run the deploy workflow with `image_tag` set to an older SHA. It skips the build. By hand: `./deploy.sh <older-sha>`. Migrations only go forward, so a rollback across one needs a deliberate decision about the schema.

**Never prune the `coursecut_caddy-data` volume.** It holds the certificates and the ACME account key.

---

## Quotas, retention and abuse limits

Platform defaults live in `/opt/coursecut/.env`. Any of them can be overridden per tenant with one `UPDATE` on `org_settings`. There is no billing and no plan tier on purpose.

| Setting | Default | Meaning |
|---|---|---|
| `QUOTA_TRANSCRIPTION_MINUTES_PER_MONTH` | 600 | The meter that matters, roughly $3.60 of Whisper |
| `QUOTA_STORAGE_BYTES` | 50 GiB | Source video plus exports, summed as a level |
| `QUOTA_MAX_UPLOAD_BYTES` | 5 GiB | Per file |
| `QUOTA_MAX_ACTIVE_JOBS` | 25 | Fairness, not capacity. The worker is concurrency 1 |
| `QUOTA_MAX_ORGS_PER_USER` | 3 | Otherwise "sign up again" is a quota reset |
| `RETENTION_EXPORT_DAYS` | 14 | Exports are derived, expiry costs a re-export |
| `RETENTION_SOURCE_DAYS` | 0 | Never expire. Deleting uploads on a timer nobody chose is not a default |
| `RETENTION_PENDING_UPLOAD_HOURS` | 24 | Abandoned upload rows |
| `RETENTION_ORPHAN_GRACE_HOURS` | 24 | Objects no row points at |
| `RETENTION_SWEEP_CRON` | `20 4 * * *` | Nightly, before the backup hour |

Operator SQL, via `docker compose -f compose.prod.yml exec postgres psql -U postgres coursecut`:

```sql
-- raise one tenant's ceiling
insert into org_settings (org_id, transcription_minutes_limit, storage_bytes_limit)
values ('<org id>', 3000, 214748364800)
on conflict (org_id) do update set
  transcription_minutes_limit = excluded.transcription_minutes_limit,
  storage_bytes_limit         = excluded.storage_bytes_limit;

-- suspend an org (blocks upload/transcribe/export, still allows read and delete)
update org_settings set suspended_at = now(), suspended_reason = 'unpaid invoice'
 where org_id = '<org id>';
```

Suspension stops spend, not access. A cost control that holds a tenant's data hostage is a different thing wearing the same name.

Email is optional. `MAIL_DRIVER` is `none` by default, which means **there is no password reset flow anywhere in the product**, not a form that silently fails. Set `MAIL_DRIVER=resend` and `MAIL_API_KEY` to turn it on.

---

## Privacy statement (the honest version)

The desktop guarantee does not apply here, so the real one is stated in the product, on the sign up screen and in the Usage dialog:

* Uploaded video is stored in object storage we control (Cloudflare R2), encrypted at rest, isolated per tenant by RLS and by key prefix.
* Video is **never** sent to any third party. Only extracted audio goes to Whisper and only transcript text goes to GPT-5.5.
* Transcripts are processed under **our** OpenAI account, not the user's, because the key is ours.
* Users can delete a project and have its objects purged.
* Logs carry paths, ids and error codes only, never transcript text or file contents.

---

## Known gaps

* **Worker and API share a droplet.** A long export makes the API slow on one vCPU. `WORKER_CPUS=0.8` is a mitigation, not a fix. Oldest open item.
* **Single droplet, single Postgres.** The nightly backup is the entire recovery plan. No replica, no failover.
* **Rate limiting is in process.** One API container makes that correct today. A restart forgives everyone, and running two containers doubles every limit. Move to a shared store before scaling out.
* **No billing.** Limits are operator set rows.
* **A database restore does not restore R2 objects.** Stop the worker before restoring, and leave it stopped until you have looked at what came back.
* **Progress feedback is worse than desktop's.** Calls now return when a job is queued, so `ProjectDetailView` drops its in flight state immediately. Everything is correct, it just feels less responsive. Fixing it means a desktop first change, since web only edits to copied views are forbidden.
* **`storage:cors` has only been exercised against MinIO's refusal path.** The R2 branch is one API call, confirm it with `--show`.
* **Terms of service** covering other people's content on our infrastructure is still unwritten.

---

## Keeping the two UIs in sync

The port is one way. `src/` is upstream, `apps/web/src/` is downstream. A UI change lands on desktop first and is then ported forward. Web only edits to a copied view are a bug unless they are one of the D1 to D8 deviations.

Every copied file carries a provenance header:

```ts
// PORTED FROM: src/views/LessonSegmentsView.tsx @ 16d83e5
// DEVIATIONS: D2 (presigned playback URL), D5 (no output directory)
// Sync with `scripts/ui-drift.sh`. Do not edit for web-only reasons.
```

`scripts/ui-drift.sh` runs `git log <sha>..HEAD` on each upstream path and fails CI if anything moved. It currently reports 35 files current.

---

## Further reading

| Doc | What |
|---|---|
| `docs/web-app-plan.md` | Full design, build notes, decision log |
| `docs/web-deploy-runbook.md` | Droplet, DNS, R2, Actions secrets, restore procedure, day 2 ops |
| `docs/PRD.md` | Desktop product spec |
| `infra/docker/.env.example` | Every production variable, annotated |
| `apps/api/.env.example` | Every local variable, annotated |
