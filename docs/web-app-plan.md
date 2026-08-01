# CourseCut Web — Implementation Plan

Status: Planning
Target: Multi-tenant web app — DigitalOcean droplet (compute) + Cloudflare R2 (storage)
Companion to: [`docs/PRD.md`](./PRD.md) (desktop, local-first — unchanged by this plan)

---

## 0. Scope & the privacy tradeoff

The desktop app's founding invariant is *"videos never leave the user's computer"* (PRD §2, [`coursecut-privacy-invariants`](../.claude/skills/coursecut-privacy-invariants/SKILL.md)). **The web app deliberately breaks that invariant** — cloud transcoding requires uploading video to infrastructure we operate.

This is a scope decision, not a bug, but it must be handled explicitly:

* The desktop app (`src/` + `src-tauri/`, untouched by this plan — see §1.1) keeps its invariant **fully intact**. `coursecut-privacy-invariants` continues to apply to it verbatim and remains a review gate for those folders.
* The web app gets its own, weaker but still explicit, guarantee documented in §9 — user video lives on infrastructure we control, is tenant-isolated, is never sent anywhere except OpenAI (audio/transcript only, same as desktop), and is deletable on request.
* **Nothing under `apps/` may reach into the desktop tree.** The web app imports no desktop file and adds no dependency the desktop build resolves; the two share source only by having been copied once (§7.1).

### Non-negotiable design constraint

> **The web app must reproduce the existing Tauri app's design and user flow exactly.** It is a port, not a redesign.

Every deviation from desktop UI/UX must be one of the forced deviations enumerated in §4 — and each one is there because the browser/cloud model makes the desktop behaviour physically impossible, not because a different design seemed nicer.

---

## 1. Why this port is cheap (the key architectural fact)

The desktop frontend has **exactly one** backend touchpoint: `src/db.ts`. Every view and component calls typed async functions there; `db.ts` wraps them in Tauri `invoke()`. There is no direct SQL surface on the frontend (no `@tauri-apps/plugin-sql`, no `sql:*` capability), and no component makes its own network call.

```
views/ + components/  ──►  src/db.ts  ──►  invoke()  ──►  Rust  ──►  SQLite / ffmpeg / OpenAI
                             ▲
                      the ONLY seam
```

So the port strategy is: **copy the views, keep the function signatures, replace the transport.**

```
src/          (desktop)      views/ + components/  ──►  src/db.ts          ──► invoke() ──► Rust
                                      │
                                      │  copied, then adapted at the seam
                                      ▼
apps/web/src/ (web)          views/ + components/  ──►  apps/web/src/db.ts ──► fetch()  ──► apps/api
```

Because `db.ts` is the only seam, the adaptation is confined to it plus the handful of components that reach for a Tauri API directly (`convertFileSrc`, `plugin-dialog`, the webview drag-drop and event channels). Everything else is copied verbatim.

### 1.1 Why a copy and not a shared package

The structurally pure version of this is a `packages/ui` compiled by both targets, so the two UIs *cannot* diverge. We are not doing that, deliberately:

* **The desktop app is shipping at v1.4.3.** Extracting `packages/ui` rewrites its build: workspace layout, `tsconfig` paths, `vite.config.ts`, `tauri.conf.json`'s `frontendDist`/`beforeBuildCommand`, `scripts/fetch-ffmpeg.sh`'s sidecar paths, and `release.yml`'s project path. That is packaging risk taken on a live app, and packaging failures surface in the installer, not in CI.
* **Web work would be blocked behind it.** Nothing about `apps/api`, the worker, or the storage model needs the restructure to exist.
* **The benefit is a guarantee we can also get by process.** Shared code makes identical UI automatic; a copy makes it a discipline. See §7.1 for the discipline — it is cheap, because the port is one-way.

So: **`src/` and `src-tauri/` are not touched by this plan at all.** The desktop app keeps its current layout, build, and release pipeline. `apps/web` is a standalone project with its own `package.json` and its own copy of the UI.

The tradeoff being accepted is drift, and it is a real cost, not a rounding error. §7.1 is the part of this plan most likely to be quietly abandoned — treat it as load-bearing.

---

## 2. Repo layout (desktop untouched, web added alongside)

```
src/                # desktop frontend — UNCHANGED, stays at the repo root
src-tauri/          # desktop Rust backend — UNCHANGED
index.html          # desktop entry — UNCHANGED
package.json        # desktop project — UNCHANGED (not a workspace root)

apps/
  web/              # standalone Vite + React SPA, own package.json + lockfile
    src/
      views/        # copied from ../../../src/views, adapted at the seam only
      components/   # copied from ../../../src/components
      hooks/
      lib/
      styles.css    # copied verbatim
      db.ts         # same exported names/signatures as desktop's, fetch() bodies
      auth/         # §4.1 sign-in/org screens — web only, no desktop counterpart
  api/              # HTTP API: auth, CRUD, presigned URLs, job enqueue, SSE progress
    drizzle/        # generated DDL + the hand-written RLS migration
    src/db/         # schema.ts, client.ts (withOrg), bootstrap, migrate, seed
    test/           # tenant-isolation.test.ts — M2's acceptance criterion
  worker/           # ffmpeg job processor — own package.json (see M5's notes)
    src/tasks/      # extract → transcribe → analyze, and export
infra/
  postgres/         # compose.yml — local Postgres + MinIO
  docker/           # api/worker/web/backup Dockerfiles, prod compose, Caddyfile,
                    # deploy.sh, .env.example — the whole droplet, in the repo
scripts/
  ui-drift.sh       # reports desktop UI changes not yet ported to apps/web (§7.1)
docs/
  PRD.md            # desktop spec — unchanged
  web-app-plan.md   # this file
  web-deploy-runbook.md  # M6's operator half: droplet, DNS, R2, secrets, restore
```

`apps/web` installs its own dependencies (`cd apps/web && npm install`) rather than joining a workspace, because making the repo root a workspace root is itself a change to how the desktop app installs and builds — exactly the risk §1.1 is avoiding. Two `node_modules` trees is the price; it buys a desktop build that is bit-for-bit the one shipping today.

### CI/CD

`.github/workflows/ci.yml` today runs one `frontend` job over the whole repo. It gains a `paths:` filter and is joined by web-side workflows, so a desktop change never triggers a web deploy and vice versa:

| Workflow | `paths:` filter | Does |
|---|---|---|
| `ci.yml` (existing) | `src/**`, `src-tauri/**`, root configs | typecheck, lint, build — desktop, unchanged otherwise |
| `ci-web.yml` | `apps/**`, `infra/**`, `src/**` | three jobs: `api` (typecheck and lint for `apps/api` *and* `apps/worker`, then migrate and the four suites — isolation, contract, pipeline, parsers — against a real Postgres, MinIO and ffmpeg), `web` (typecheck, lint, build, `ui-drift.sh`) and `infra` (M6: `compose config`, `caddy validate`, `shellcheck`) |
| `deploy-web.yml` | `apps/web/**`, `apps/api/**`, `apps/worker/**`, `infra/docker/**` (on `main`) | build four images → DO Container Registry → rsync the stack files → `deploy.sh` over SSH → curl the public `/api/health`. `workflow_dispatch` with an existing tag is the rollback path |
| `release.yml` | tag-triggered | desktop release artifacts — **unchanged**, since the desktop tree never moves |

There is no shared-code tripwire to rely on here, which is the point of `ui-drift.sh` (§7.1) — it is the substitute, and it runs in `ci-web.yml`.

---

## 3. Runtime architecture

Stack: **plain PostgreSQL**, no Supabase. Because this plan already includes a first-party API layer (`apps/api`), most of what Supabase bundles would have been redundant with code we are writing anyway. Dropping it removes seven services and adds exactly one real responsibility: authentication.

### 3.1 Stack

The table is laid out against Supabase's components because that is how the stack was derived — self-hosted Supabase was the starting point, and decomposing it showed most of the bundle duplicated code `apps/api` was going to own anyway.

| Concern | Choice | Note |
|---|---|---|
| Database | **Plain Postgres 16 (Docker)** | The only part of Supabase we actually wanted |
| Auth | **`better-auth`** — sessions, password hashing, OAuth, organization/multi-tenancy plugin | Replaces GoTrue. The one genuinely new thing to build; verify current maturity before committing. Fallback is argon2id + httpOnly session cookies — small, but a bad place to be wrong |
| CRUD / REST | **`apps/api` (Hono)** | Replaces PostgREST, which was always going to be redundant |
| Progress push | **SSE from `apps/api`** | Replaces Realtime. Simpler than a websocket layer; progress is one-directional server→client |
| Object storage | **Cloudflare R2 via presigned URLs** (MinIO locally) | See §3.4 — chosen over Supabase Storage, DO Spaces and S3 on egress cost |
| TLS / gateway | **Caddy** | Replaces Kong, and terminates TLS, which we needed regardless |
| DB admin UI | **Drizzle Studio / psql / TablePlus** | Replaces Studio. Dev-time convenience, not infrastructure |
| Image processing | — | imgproxy never needed |

Supporting choices: **Drizzle ORM + drizzle-kit** for typed queries and migrations (TS-first, and its generated types line up with the shapes `apps/web/src/db.ts` already declares), **graphile-worker** for the job queue (Postgres-backed, no Redis).

### 3.2 Topology

```
   Browser
      │  1. request presigned PUT
      ▼
┌───────────┐   2. enqueue job (graphile-worker)  ┌──────────────┐
│ apps/api  │ ──────────────────────────────────► │  Postgres    │
│  (Hono)   │ ◄──── 5. job status / SSE ───────── │              │
└───────────┘                                      └──────▲───────┘
      │                                                   │ 4. write transcript/lessons
      │  Browser uploads DIRECTLY ──┐                     │
      ▼                             ▼              ┌──────┴───────┐
 (never proxies video bytes)   ┌─────────┐         │ apps/worker  │
                               │   R2    │◄────────│  ffmpeg      │
                               │  (S3)   │────────►│  Whisper/GPT │
                               └─────────┘         └──────────────┘
                                  3. worker pulls source, pushes output
```

**Decisions and why:**

* **Uploads/downloads bypass the API.** Browser ↔ R2 directly via presigned URLs. Proxying multi-GB lecture video through the API droplet would burn its bandwidth and RAM for zero benefit.
* **Postgres-backed queue, not Redis.** One less service to secure, patch, and back up, for no capability we need at this scale.
* **Worker is a separate process, and eventually a separate droplet.** ffmpeg is CPU-bound and long-running; an HTTP request cannot stay open for a 40-minute transcode. This is also the only component that needs to scale with load.
* **Vite SPA, not Next.js.** Next's App Router would push the copied view tree toward RSC and a restructure — which would turn a mechanical copy into a rewrite and make §7.1's drift check meaningless. A Vite SPA runs the copied views as they are. `apps/api` is a separate Hono service (small, TS-first; Fastify is a fine substitute if more batteries are wanted).

### 3.3 Sizing

The earlier blocker — self-hosted Supabase's ~8 containers wanting ≥4 GB before any video work — is gone with Supabase itself.

Production footprint is now roughly: Postgres (~256–512 MB) + api (~150 MB) + worker (~200 MB, plus ffmpeg spikes) + Caddy (~50 MB).

| | Current droplet (1 vCPU / 2 GB / 50 GB) | Verdict |
|---|---|---|
| **RAM** | Fits | Workable for development and light single-tenant use |
| **CPU** | 1 vCPU | The real bottleneck — ffmpeg re-encoding a 1-hour lecture on one core is slow, and it will starve the API while running |
| **Disk** | 50 GB | Fine, since R2 holds the video; only scratch space is local |

So the upgrade is now about **throughput, not viability** — the stack will boot and run on 2 GB. Upgrade before real multi-tenant load, prioritizing vCPU:

| Role | Spec | Notes |
|---|---|---|
| api + Postgres | 2 vCPU / 4 GB | comfortable headroom |
| worker | CPU-optimized, 2–4 vCPU | scale/add first under load; can be on-demand |
| R2 | — | video bytes never sit on either droplet long-term |

### 3.4 Storage: Cloudflare R2 (not DO Spaces)

Object storage and compute are split across two vendors deliberately, each used for what it is cheapest at: **Cloudflare for bytes and bandwidth, DigitalOcean for CPU and RAM.**

The deciding factor is **egress** — outbound data transfer, which is metered by most providers while inbound is free. CourseCut is unusually egress-heavy because a stored video is read out repeatedly: browser playback and scrubbing during transcript editing, export downloads, and — the largest and least obvious — the worker pulling the entire source file for every ffmpeg job. A 2 GB lecture realistically generates 7–8 GB of egress over its life, a ~4:1 ratio. This product does not pay to *store* video so much as to *move* it.

| | Cloudflare R2 | DO Spaces | AWS S3 |
|---|---|---|---|
| Storage | $0.015/GB | $5/mo base (250 GB + 1 TB egress), then $0.02/GB | ~$0.023/GB |
| **Egress** | **$0** | $0.01/GB over 1 TB | $0.09/GB over 100 GB |
| 1 TB stored + 5 TB egress | **~$15/mo** | ~$60/mo | ~$465/mo |

*(Prices as researched; re-check before committing spend.)*

AWS S3 is disqualified by our own topology: S3→EC2 in-region is free, but our compute is a DigitalOcean droplet, so every worker download would bill as internet egress at premium rates to move video to a machine that isn't AWS's.

R2's zero egress is strategic pricing, not magic — Cloudflare's settlement-free peering makes its marginal cost genuinely near zero, and it monetizes storage plus **operations** ($4.50/M writes, $0.36/M reads). That operations charge is the real catch for workloads with millions of small objects; CourseCut is the opposite shape — few objects, enormous bytes — so request counts stay far inside the free tier. The pairing also zeroes the biggest single egress line: R2 charges nothing for egress to the droplet, and DO charges nothing for inbound, so **worker source-video downloads are free on both ends**.

#### Portability rules (keep the exit cheap)

Zero egress is a business decision, not physics. Depend on the price, not the vendor — these three rules keep a migration to Spaces or S3 a half-day config change plus an unattended copy, rather than a data migration:

1. **Store keys, never URLs.** `videos.storage_key` / `exports.output_key` hold `{org}/{project}/{video}/source.mp4` — never a bucket hostname. If a hostname reaches the database, the vendor is baked into your data.
2. **One storage module.** All S3 calls live in a single `storage.ts` shared by `apps/api` and `apps/worker`. Never construct an `S3Client` inside a route handler.
3. **Bucket hostnames never reach the frontend.** The SPA only ever receives server-minted presigned URLs, so the client is never coupled to the provider.

These are easy to violate silently during M3/M5 — treat them as review gates, not aspirations.

---

## 4. Forced deviations from desktop behaviour

These are the *only* sanctioned differences. Everything else must match desktop exactly.

| # | Desktop | Web | Why forced |
|---|---|---|---|
| D1 | `importVideos(projectId, paths[])` — native file dialog, files stay in place | Browser file picker → presigned PUT to R2 → register rows | Browsers have no filesystem paths |
| D2 | Playback via `convertFileSrc(file_path)` | Presigned, short-TTL GET URL; `videos.file_path` → `storage_key` | No local file access |
| D3 | `extractAudioForVideo` / `transcribeVideo` / `analyzeVideo` return when done | Enqueue a job, return job id; completion arrives via D4 | HTTP cannot hold a connection for a long transcode |
| D4 | Progress via Tauri `"video-progress"` channel → `useVideoProgress.ts` | Same hook, same `VideoProgress` shape, **SSE** transport | No Tauri event bus in a browser |
| D5 | `queueExport(lessonIds, outputDir)` writes to a chosen folder | No `outputDir`; worker writes to R2, UI offers a download | Browsers cannot write to arbitrary folders |
| D6 | `revealInFolder(path)` opens Finder/Explorer | Download link / open in new tab | No OS shell access |
| D7 | OpenAI key (BYOK) in OS keychain (`settings.rs`) | **Platform-owned key** in the API's environment. No key surface in the product at all: no Settings section, no missing-key banner, no pre-flight check, no `KeyStatus`/`KeyTestResult` | No keychain in a browser — and the web product is not BYOK |
| D8 | No login — single local user | `better-auth` sessions; org/user layer above `projects` | Multi-tenant |

**Deliberately unchanged:** every view, the navigation graph in `App.tsx` (home → project → video[transcript\|lessons] → lessonSegments, plus settings and exportHistory), breadcrumbs, keyboard shortcuts, transcript-mode-primary editing, lesson card layout, segment scrubber, AI edit prompt + review popup, confidence badges, dark mode.

D4 is worth calling out as a win: because `useVideoProgress` already consumes a typed `VideoProgress` struct rather than raw events, only its subscription line changes — the progress UI itself is untouched.

#### D7 in detail — the platform key

This is the only deviation that *removes* UI rather than re-implementing it, so it is worth being precise about what goes and what stays.

The web app is **not** bring-your-own-key. One OpenAI key lives in the API's environment, is used for every tenant, and never reaches the browser or the database. Three pieces of desktop UI therefore have no reachable state and are gone:

| Removed | Was in | Why it cannot stay |
|---|---|---|
| "OpenAI API key" settings section (status line, `sk-...` input, Save, Test Connection) | `SettingsView` | Every control would be a no-op |
| Missing-key warning banner + "Add API key" | `HomeView` | The condition is never true |
| Pre-flight key check before extraction | `ProjectDetailView` | "No key saved" is unreachable |

Correspondingly, `apps/web/src/db.ts` drops `saveOpenAiKey`, `getOpenAiKeyStatus`, `testOpenAiKey`, `KeyStatus` and `KeyTestResult` — the one place its exported surface is a strict subset of desktop's rather than a match. They are removed rather than stubbed so the compile error lands in the views that must change, instead of shipping a form that silently does nothing.

**Analysis instructions are untouched and stay per-org.** Users still shape what the model does; they just don't pay for it. `org_settings.analysis_instructions` remains exactly as desktop's `app_settings` row behaved.

**The cost consequence is the real one.** BYOK was chosen partly to avoid absorbing unbounded API cost; a platform key moves transcription and analysis spend onto us, metered by however much video tenants upload. That makes M7's per-org quotas and cost caps load-bearing rather than a hardening nicety — they gate the first untrusted signup, not general availability. `org_settings` is where those limits land. Until they exist, treat the web app as invite-only.

*They exist as of M7* — `org_settings` holds the overrides, `usage_events` holds the meter, and `apps/api/src/quota.ts` is the gate. The invite-only advice above is discharged on that account.

The key itself is a deployment secret: droplet env file and GitHub Actions secrets, never the repo and never the database (§8). A column that does not exist cannot leak, which is why `org_settings` has no key field rather than an encrypted one.

### 4.1 New surfaces (no desktop counterpart)

D8 is the only deviation that adds **screens** rather than changing a mechanism. The desktop app has no login, no accounts, and no notion of an organization, so these have nothing to port and must be designed:

| Surface | Notes |
|---|---|
| Sign up / sign in | Email + password at minimum; OAuth optional later |
| Forgot / reset password | Needs transactional email. Deferred at M3, shipped around at M4, **delivered at M7** — the provider became a deployment variable (`MAIL_DRIVER`) rather than a decision, and the flow exists exactly where mail is configured |
| Usage & limits | Web-only, added at M7: what the org has spent this month against its quotas, the retention actually in force, plan §9's privacy statement, and the owner's "delete this organization" |
| Org switcher | Only render when a user belongs to more than one org, so single-org users see the desktop experience unchanged |
| Members / invites | Invite by email, list members, remove. Roles can start as owner/member |
| Account settings | Sits alongside the existing `SettingsView`, not replacing it |

**The governing rule:** build these strictly from the primitives already copied into `apps/web/src/components/ui` (`button`, `input`, `label`, `card`, `dialog`, `alert`, `select`, `separator`, …). No new design language, no new component library, no restyling. These screens should look like they shipped with the desktop app.

They live under `apps/web/src/auth/` — a directory with no desktop counterpart, deliberately separate from the copied views so `ui-drift.sh` (§7.1) can compare like with like and never flags them.

**Where org scoping shows in existing UI:** `HomeView` lists projects with no org concept today. In web it lists the *active org's* projects. For a single-org user that renders identically; the org switcher is the only added chrome, and it stays hidden until a second org exists.

**Session handling stays out of `db.ts`.** Its exported surface must stay a superset-free match of desktop's, or the drift check becomes noise and the copied views start depending on web-only concepts. Sessions are httpOnly cookies sent automatically by `fetch`, with a `useSession` hook local to `apps/web/src/auth/` gating routes above the view tree. No copied view ever sees auth state.

---

## 5. Local development (Phase 1 — start here)

Everything runs on the dev machine via Docker. No droplet involvement. Three containers instead of Supabase's eight:

```sh
docker compose -f infra/postgres/compose.yml up -d --wait   # postgres + minio

cd apps/api
cp .env.example .env
npm install
npm run db:reset     # bootstrap (roles/grants) → migrate → seed
npm test             # isolation + contract + pipeline + parser suites

npm run dev:api      # Hono API on :3000

cd apps/worker       # its own package (M5) — reads apps/api/.env
npm install
npm run dev          # graphile-worker + ffmpeg

cd apps/web
cp .env.example .env  # VITE_API_MODE=live — without it the SPA uses the mock
npm install && npm run dev                                   # Vite SPA on :5173
```

* **Signing in.** The seed creates `ada@example.com` and `grace@example.com`, both with password `coursecut-dev-password` (`SEED_PASSWORD` in `apps/api/src/db/seed.ts`). Ada is in both orgs, Grace only in Globex — so one of them exercises the org switcher and the other proves a single-org user still sees the desktop UI with no extra chrome.
* **Quotas and mail are off the default path locally** (M7). The platform defaults in `env.ts` are generous enough that ordinary development never meets one; to see a refusal, set a limit on an org (`update org_settings set transcription_minutes_limit = 0 where org_id = 'org_acme'`). Password reset appears only with `MAIL_DRIVER=log`, which prints the link to the API's output instead of sending it. `npm run retention:sweep` runs the collection the worker otherwise runs nightly.
* **The SPA talks to a live API** with `VITE_API_MODE=live`; without it, `apps/web` keeps using M1's in-memory mock (`import.meta.env.DEV` gates it), which stays useful for UI work with no backend running.

* **Storage:** MinIO locally, Cloudflare R2 in prod — both S3-compatible, so one `@aws-sdk/client-s3` client with only the endpoint/credentials swapped (R2 uses `region: "auto"`). No code difference. CORS is the one exception: MinIO has no per-bucket CORS API, so it is set server-wide via `MINIO_API_CORS_ALLOW_ORIGIN` in `compose.yml`, while R2 takes a per-bucket policy — applied by `npm run storage:cors` (M6), which prints MinIO's refusal as a no-op rather than a failure. A deployment difference, not a code one.
* **ffmpeg:** system binary locally; pinned in the worker's Dockerfile for prod.
* **Auth:** real sessions from day one — no stub to retrofit later.
* **Seed:** two orgs (`acme`, `globex`), each with a project and a video; Acme also has a transcript and a multi-segment lesson. A second org is not decoration — without it there is nothing for a tenant-isolation test to fail against. One user belongs to both, so the org switcher (§4.1) has something to switch between while the other user stays single-org and must see the desktop UI unchanged.
* **Port conflicts:** `POSTGRES_PORT=55432 docker compose …` if 5432 is taken (an SSH tunnel to a remote database is the usual culprit); point `apps/api/.env` at the same number.
* **Two database URLs.** `DATABASE_URL` is the least-privilege app role that RLS actually applies to; `DATABASE_ADMIN_URL` is the privileged role used only by migrate/bootstrap/seed. Never serve a request with the second — every policy silently stops applying.

Rule of thumb: **if it needs the droplet to test, it is not Phase 1.**

---

## 6. Data model

Port the six SQLite migrations (`0001_init` … `0006_lesson_segments`) to Postgres, preserving column names and semantics so the TS types in `apps/web/src/db.ts` stay identical to desktop's. See [`coursecut-data-model`](../.claude/skills/coursecut-data-model/SKILL.md) for the current shape.

**Additions for web:**

| Change | Detail |
|---|---|
| `users`, `sessions`, `orgs`, `memberships` | owned by `better-auth` (+ its organization plugin) rather than an external auth service |
| `projects.org_id` | every project belongs to an org |
| `videos.file_path` → `storage_key` | R2 object key, prefixed `{org_id}/{project_id}/{video_id}/…` |
| `videos.upload_status` | `pending` \| `uploaded` \| `failed` — the upload step desktop never had |
| `jobs` | graphile-worker's tables plus our own job row: kind (`extract`\|`transcribe`\|`analyze`\|`export`), state, attempt, progress, error |
| `exports.output_path` → `output_key` + `download_expires_at` | R2 object, not a local folder |
| `org_settings` | `analysis_instructions` only (desktop's `app_settings`, per org). **No OpenAI key column** — D7. M7 adds the per-org limit overrides and the suspension switch, none of them user-editable |
| `usage_events` (M7) | Append-only meter: one row per unit of metered work actually performed. **No FK to `videos`** — a usage row must outlive what it describes, or deleting a video refunds the month |
| `videos.size_bytes`, `exports.size_bytes` (M7) | The storage meter. Summing a column is a millisecond; listing a tenant's bucket on every upload request is not |

Built at M2 in [`apps/api/src/db/schema.ts`](../apps/api/src/db/schema.ts). Three conventions there differ from what this section originally assumed, each for a reason found while writing it:

* **Ids are `text`, not `uuid`.** `better-auth` mints its own ids and they are not UUIDs; desktop already treats ids as opaque TEXT throughout. So the RLS comparison below is text-to-text, with no `::uuid` cast.
* **`created_at`/`updated_at` are `timestamptz`.** Desktop stores ISO-8601 strings only because SQLite has no date type. The API serializes them back to ISO strings, so `db.ts` still sees `string`.
* **Every tenant table carries `org_id` directly**, so a policy is a single-column check rather than a join up to `projects`. The usual risk — a child's `org_id` drifting from its parent's — is closed with composite foreign keys: each table has `UNIQUE (id, org_id)` and children reference `(parent_id, org_id)`. A mismatched pair is unrepresentable rather than merely discouraged, which is a stronger guarantee than RLS alone can give, since a policy only ever sees the row in front of it.

### Tenant isolation

With a first-party API it is tempting to scope every query in application code and skip Postgres RLS. **Don't** — keep RLS as defense in depth. The mechanism:

* `apps/api` opens each request's transaction and pins the org to it — `withOrg()` in [`apps/api/src/db/client.ts`](../apps/api/src/db/client.ts) issues `set_config('app.current_org_id', $1, true)`. The function form is used rather than the literal `SET LOCAL` statement because `SET LOCAL` takes no bind parameters, and scoping by string-interpolating a tenant id into SQL is exactly what this mechanism exists to survive. `true` makes it transaction-local, so a pooled connection cannot carry one request's org into the next.
* RLS policies on every tenant table check `org_id = current_setting('app.current_org_id', true)`. The second argument is `missing_ok`: unset yields NULL, and `org_id = NULL` is never true, so a query that skipped `withOrg()` returns **nothing**. Fail-closed. The one-argument form raises instead, which sounds stricter but turns "no org context" into an error to be caught and swallowed.
* The API connects as a role **without** `BYPASSRLS` and without ownership of the tables ([`bootstrap.ts`](../apps/api/src/db/bootstrap.ts)); migrations use a separate privileged role. Both are necessary — a superuser ignores RLS outright, and a table's owner ignores it unless the table is `FORCE`d, which every tenant table here is.

That preserves the defense-in-depth property: a single forgotten `WHERE` clause cannot leak another tenant's data. Combined with the per-org R2 key prefix, isolation holds at both the data and object layers.

**This is proven, not asserted.** [`apps/api/test/tenant-isolation.test.ts`](../apps/api/test/tenant-isolation.test.ts) runs as the app role against a real Postgres and deliberately writes the forgotten-scoping bug — unscoped `SELECT`s, a lookup by another tenant's primary key, an insert stamped with a foreign `org_id` — asserting each comes back empty or rejected. It also asserts the connection is genuinely unprivileged, so pointing `DATABASE_URL` at `postgres` fails CI rather than passing every other test for the wrong reason. It runs in `ci-web.yml` against a Postgres service container.

**Content-hash transcript caching (PRD §7.4) stays**, but must be **scoped per-org**. Cross-tenant cache sharing would leak the fact — and content — of one tenant's video to another. This is a security requirement, not an optimization detail.

---

## 7. Milestones

Ordered so each step is independently verifiable, and so nothing depends on the droplet until M6.

| M | Deliverable | Done when |
|---|---|---|
| **M0** | Droplet hardening (see §8) — do this first regardless, the current credential is compromised | Password rotated, key-only SSH, `ufw` + fail2ban up |
| **M1** ✅ | `apps/web` scaffold: standalone Vite SPA, UI copied from `src/`, `db.ts` reimplemented over `fetch`, `ui-drift.sh` | The desktop UI renders in a browser against a stubbed API; `git diff` shows **zero** changes under `src/`, `src-tauri/`, or root configs |
| **M2** ✅ | Local Postgres + MinIO compose, Drizzle schema, RLS, seed | RLS proven by a cross-tenant read test that **fails** as expected |
| **M3** ✅ | `apps/api`: `better-auth` sessions, org/project/video/lesson CRUD, presigned URLs (**multipart**), bucket CORS, SSE | `apps/web`'s `db.ts` passes contract tests against the real API; a multi-GB file uploads from the browser in parts |
| **M4** ✅ | `apps/web` wired to the real API, plus the §4.1 auth screens | Full flow works locally; UI visually diffed against desktop |
| **M5** ✅ | `apps/worker`: extract → Whisper → GPT-5.5 → export, with progress events | A video uploaded in the browser produces lessons and a downloadable MP4 |
| **M6** ✅ | Prod deploy: Postgres, api, worker, Caddy/TLS, backups; real R2 bucket + CORS + scoped API token | End-to-end works against the droplet |
| | *Built and verified locally as a whole stack; the droplet, the domain and the R2 account are the operator steps in [`docs/web-deploy-runbook.md`](./web-deploy-runbook.md)* | |
| **M7** ✅ | Multi-tenancy hardening: quotas, retention/deletion, abuse limits, cost caps | A second org can be onboarded safely |

M1 is now additive-only, which is what makes it safe to start with: nothing it does can break the shipping desktop app, because it touches no file the desktop app builds from.

M3's auth work is the one place this plan adds net-new security-sensitive code. Prefer the library's defaults over custom crypto.

**M2 as built.** `apps/api` was created a milestone early, holding only the database layer — the Drizzle schema, migrations, bootstrap, seed and isolation tests. §2's layout put migrations under `infra/postgres/`, but the schema is TypeScript that `apps/api` and `apps/worker` both import, and splitting a Drizzle schema from the code it types buys nothing. `infra/postgres/` keeps what is genuinely infrastructure: `compose.yml`. M3 adds routes to a package that already exists.

Two things M2 leaves for M3, deliberately:

* **The `better-auth` tables are hand-shaped, not generated.** `users`/`sessions`/`accounts`/`verifications`/`organizations`/`members`/`invitations` match the library's documented schema but use this codebase's naming (plural tables — `user` is a reserved word — and snake_case columns). M3 must configure the corresponding `modelName`/`fields` mapping and reconcile against `npx @better-auth/cli generate`, which is the authority on those seven tables. The mapping needed is written out in `schema.ts`'s header.
* **Seeded users have no credentials.** Passwords are `better-auth`'s to hash, and inventing a hash it might not recognise would be worse than having none, so the seed creates users and memberships but no `accounts` rows.

**M3 as built.** Both of those are now closed — the seed hashes with `auth.$context`'s own hasher, so a seeded account is indistinguishable from a registered one. Six things are worth recording because they differ from what this plan assumed:

* **The `better-auth` mapping needed one knob, not seven.** `usePlural: true` and nothing else: the Drizzle adapter addresses columns by each table's *JavaScript* property name, which M2's schema had already written in the camelCase the library uses. `schema.ts`'s header listed a per-field mapping that turned out to be unnecessary; it now records the reconciliation instead. `npm run auth:generate` reproduces the check.
* **The upload ticket is server-shaped.** `POST /projects/:id/uploads` returns `{mode: "single", url}` or `{mode: "multipart", upload_id, part_size, part_count}`, and the client branches on what it is told. Whether a file needs parts is a storage-side fact (S3's per-PUT ceiling, the 5 MiB part floor); duplicating the threshold in the browser would be two places to get it wrong. Part URLs are signed a batch at a time, not all up front, so a slow multi-hour upload cannot outlive its signatures.
* **The extract → transcribe chain moves server-side.** `ProjectDetailView` chains the two on `audio_path` being set, which against a job queue never fires — the call returns before anything has run. The chain becomes the worker's (M5): the extract job queues transcription on success. That is D3 working as designed, and the copied view is left alone rather than edited for a web-only reason (§7.1).
* **`previewLessonSegmentEdit` returns 501, deliberately.** It is the only call in `db.ts`'s surface needing a live model *inside* the request, so it lands with the model code at M5 rather than being written twice. Returning the baseline unchanged would have been worse than refusing — it would look like the model read the instruction and declined.
* **Progress rides Postgres `LISTEN`/`NOTIFY`, not an in-process emitter.** The publisher is a different process today and a different droplet later (§3.2); the database is the only thing both share. `NOTIFY` inside the request transaction also means an event is delivered only if the transaction commits.
* **A session with no active org re-adopts one instead of 403ing.** Found while testing the switcher: `better-auth`'s `set-active` *clears* the session's active org as part of refusing a switch to an org the user does not belong to. The refusal is right; the side effect locked the user out of the org they were already in until they signed out. `requireOrg` now falls back to the oldest membership and writes it back, and only a user with zero memberships gets a 403. There is a regression test.
* **CI boots `infra/postgres/compose.yml` rather than re-describing it.** M3's tests move real bytes through S3, MinIO cannot be a GitHub service container (its image needs a `server /data` command, and `services:` has nowhere to put one), and a compose file CI never runs is a compose file that breaks silently.

**M4 as built.** The view tree needed no wiring: `db.ts` was already the only seam and already spoke `fetch`, so M4 is almost entirely the §4.1 surfaces, which live in `apps/web/src/auth/` and are the only new code. `main.tsx` gained one wrapper (`<SessionGate>`), and **no copied view was touched** — `ui-drift.sh` still reports 35 files current, which is the check that the port stayed a port.

Six things worth recording:

* **The gate is the whole auth surface.** `SessionGate` decides between the sign-in screen, an org-less account's "create an organization" screen, and the app; `AppShell` adds one muted row above `main.app-shell` (org switcher, Members, account name). Everything else the desktop app renders is untouched, and no view below the gate can see a session — which is what keeps `db.ts`'s exported surface a match for desktop's.
* **Switching orgs remounts the view tree** (`children` keyed by the active org id). The copied views hold their rows in `useState` and have no idea tenancy exists, so leaving them mounted across a switch would render one org's data under another org's name.
* **A 401 from a copied view's own data call routes back to the gate.** `api/http.ts` reports it through a handler `SessionGate` registers, so a revoked or expired session lands on the sign-in screen instead of leaving "Unauthorized" wherever the call happened to be. Verified by deleting the session row mid-session.
* **The org switcher reads `GET /api/orgs`, not `better-auth`'s `organization.list()`.** The server is the authority on which tenant a request actually executed as — `requireOrg` re-checks membership and can adopt a different org than the session column names (M3's fallback). Writing the active org still goes only through `better-auth`'s `set-active`, so that column keeps a single writer.
* **Invitations are links, not emails, and that is not a stub.** `better-auth` creates the invitation row whether or not `sendInvitationEmail` is configured, so the Members dialog hands the inviter a `…/?invitation=<id>` link to send however they like; the gate accepts it once a session exists and strips the parameter. The invitee must sign up with the invited address, and the dialog says so. When the email provider lands, the mail becomes the primary path and nothing here changes.
* **No "forgot password" link, and email is read-only in Account settings.** Both need the provider that §10 still lists as undecided, and a form whose mail never arrives is worse than an absent one — the same reasoning D7 applies to the desktop key UI. This is the only §4.1 row not delivered, and it is blocked on that decision rather than on effort. *(M7 closed the first half: reset exists wherever `MAIL_DRIVER` is configured, and nowhere else. Email is still read-only, because a change of address needs verification on every deployment, including the ones with no mail at all.)*

**Verified locally end to end**, against the real API, Postgres and MinIO: sign in as a seeded user, switch orgs (and watch the project list change with it), open a project → transcript → lessons, upload an mp4 from the browser straight to storage (the object lands under `org_acme/…`), invite a user, sign up through the invitation link and land in the inviter's org, sign up fresh and get a new empty org, and get bounced to sign-in when the session is revoked. Mock mode (`VITE_API_MODE` unset) still bypasses the gate entirely, so M1's "clickable UI with nothing running" survives.

**M5 as built.** The pipeline runs: an MP4 uploaded from the browser is extracted, transcribed, analyzed into lessons, and exported to a file the UI can hand back as a download. `apps/worker` is the new package; `apps/api` gained the OpenAI module, the queue wiring and one migration. Nine things are worth recording.

* **`apps/worker` is its own npm package, not a second entry point of `apps/api`.** §5 originally had `npm run dev:worker` run from `apps/api`, on the reasoning that the worker is a separate *process*, not a separate project — it imports this repo's schema, storage, events and OpenAI modules directly, and a second dependency tree means two copies of drizzle in one import graph. That turned out to be the wrong trade, for a reason that is structural rather than aesthetic: with no `package.json` above it, a bare `import "drizzle-orm"` from a worker file walks up past `apps/` and resolves against the **desktop app's** `node_modules`, which §0 forbids outright. So the worker installs its own dependencies, and the duplicate-drizzle problem is solved instead by `apps/api/src/db/ops.ts` — a re-export of the query operators, so the worker builds queries with the same copy that owns the connection. Its only direct dependency is `graphile-worker`.
* **The queue needed a policy, not just a grant.** `graphile-worker` enables RLS on its private tables and writes no policies, because it expects the process using the queue to *own* those tables — an owner is exempt unless the table is FORCEd, and its tables are not. We connect as neither owner nor superuser on purpose (§6), so `add_job` failed with "new row violates row-level security policy" until `bootstrap.ts` added a permissive policy for the app role. Permissive is right here: these tables hold a task name, a payload and a schedule, have no `org_id`, and every handler resolves the payload's org through `withOrg` before touching a tenant row. Scoping the queue would protect nothing and break enqueueing.
* **Enqueueing is transactional, and keyed.** `add_job` runs on the request's own transaction, so a queued job exists only if the row it describes commits. Every job is keyed by what it operates on (`extract:<video>`, `export:<export>`) with `add_job`'s default replace mode, so a double-clicked Retry collapses into one job instead of two encodes of the same lesson. `max_attempts` is 3 rather than the default 25: retrying is the *user's* call in this product, a handler that fails for a real reason records that itself and returns normally, and 25 automatic attempts at a Whisper call is 25 times the bill for one failure.
* **`videos (org_id, content_hash)` stopped being unique** (`0002`). M2 made it unique so "the cache cannot fan out"; M5, the first milestone that writes the column, found that this makes it impossible to *record* the second import of the same file — an ordinary thing to do, and the second video's extract job would have died on a unique violation. Duplicate rows sharing a hash are not a failure of the cache, they are how it works: desktop's lookup finds an already-extracted sibling and copies its work. The per-org property was never uniqueness's to provide — RLS is what makes the lookup tenant-scoped.
* **The audio cache copies rather than shares.** Desktop points many rows at one content-hash-keyed WAV and never deletes from that cache. An object shared between two rows would outlive the delete §9 promises purges a video, so a cache hit instead does a server-side `CopyObject` into the new video's own prefix: no download, no upload, no ffmpeg, and each video still owns everything under its own key.
* **A failed analysis does not mark the video errored.** Desktop's `mark_error` covers extract and transcribe only, and copying that exactly matters more than it looks: `error` is in `ProjectDetailView`'s `PRE_TRANSCRIPT_STATUSES`, so writing it after a successful transcription would make the transcript unreachable because the *lesson analysis* failed — losing more than the step that broke.
* **Cancellation crosses a process boundary.** Desktop kills the ffmpeg child from the same process that owns it. The API cannot, so it marks the row and the worker polls it every couple of seconds during an encode and kills the child itself. Desktop's post-encode status check is ported unchanged and is what makes it stick either way: a `cancelled` row is never overwritten with `done`, and anything already uploaded is removed.
* **`previewLessonSegmentEdit` is no longer a 501.** The model code it was waiting for landed here, in `apps/api/src/openai.ts` rather than in the worker — the worker imports it, so it is still written once, and the dependency runs one way. M3's test asserting the refusal was the tripwire for exactly this, and it fired: it kept running after the route started working and reached the live API before it was rewritten. The suite now pins `OPENAI_BASE_URL` at an address nothing listens on, so a model call that slips into a test fails in a second instead of spending money.
* **The worker is safe to restart, and only because there is one of it.** Startup fails any `running` export or job as interrupted, so a bar that can never move becomes a Retry button — the same assumption desktop's `reconcile_interrupted_exports` makes about its single in-process worker, and what concurrency 1 and one deployed container buy. Scaling the worker horizontally (§3.3 anticipates it) needs this narrowed to jobs the instance owned.

**One consequence of D3 that M5 does not fix, and should be named.** The copied views were written against calls that returned when the work was done, and they now return when it is queued. `ProjectDetailView` therefore drops its in-flight state immediately, so the progress events the worker publishes have nowhere to render, and `TranscriptStageView` navigates to a lessons page that fills in a minute later. Everything *is* correct — the rows land, the status badge is right on the next fetch — but the feedback is worse than desktop's, and closing that gap means editing copied views, which §7.1 forbids without porting the change to desktop first. It belongs in a desktop-first change (a "working…" state driven by `VideoProgress` rather than by the call being in flight), not in a web-only patch.

**Verified locally end to end**, against the real API, Postgres, MinIO and ffmpeg: a six-second MP4 uploaded through the shipped client is extracted (duration probed, WAV in storage under its own prefix), transcribed, analyzed into two lessons — with the silence trim pulling one lesson's start out of the transcript's dead air before anything was written — and exported to an MP4 that `ffprobe` agrees is the length the lesson asked for, reachable through the same download URL "Reveal in Finder" opens. A multi-segment lesson comes back as one joined file without the excluded gap; a cancelled export leaves no object; a re-uploaded file reuses its sibling's audio. The worker process itself was run against the real queue to confirm it registers both tasks and drains what the API enqueues.

**M6 as built.** The stack is described entirely in `infra/docker/` — four images (api, worker, web, backup), one compose file, one Caddyfile, one deploy script — and `deploy-web.yml` builds, pushes and rolls it. The operator half (droplet hardening, DNS, the R2 buckets and tokens, the Actions secrets) is [`docs/web-deploy-runbook.md`](./web-deploy-runbook.md), because none of it is expressible in the repo and all of it is easy to get subtly wrong.

It was verified by **running the production stack locally** — the real `compose.prod.yml` and `Caddyfile`, the images as built, with a throwaway MinIO standing in for R2: migrate bootstrapped and migrated, the API came up healthy, the worker registered both tasks against the queue, Caddy served the SPA and proxied `/api`, sign-up and org creation worked through the proxy, the SSE stream's headers arrived immediately rather than at the end, and the backup container dumped to storage, pruned an old dump and produced a file `pg_restore` reads back. What is left for the droplet is the droplet: a real certificate, a real bucket, and real video.

Seven things are worth recording.

* **`tsx` became a runtime dependency**, because the images run the same TypeScript a developer runs — no build step, no second set of files to be wrong. That move changed npm's hoisting (a prod dependency's `esbuild` wins the top-level slot over a dev one's), which made `npm ci` reject the lockfile. Regenerating the lock **inside Linux** fixed it additively: 27 entries added, zero versions changed. Regenerating it on macOS instead produced a lock that was wrong on the runner, which is a good argument for doing lockfile surgery in the environment CI actually installs in.
* **Build contexts are `apps/`, not the repo root.** The desktop tree is then not reachable from any image build, which turns §0's "nothing under `apps/` may reach into the desktop tree" from a rule into a property of the build. It also matters concretely: the worker's context needs `apps/api` present, and a bare `import "drizzle-orm"` from `apps/api/src` resolving against the *desktop* app's `node_modules` is exactly the failure M5 designed the worker's own `package.json` to prevent.
* **The worker's scratch volume mounts one level above `WORKER_SCRATCH_DIR`.** `clearScratch` removes the scratch root and recreates it, and removing a directory needs write permission on its *parent* — so a volume mounted directly at that path makes the parent root-owned and the worker crash-loops on EACCES before it ever takes a job. Found by running the stack, not by reading it.
* **An empty `ACME_EMAIL` is not "no contact address", it is a Caddyfile syntax error**, and Caddy refuses the entire config — the site does not come up at all. It was optional in the first draft, which would have been a first-deploy outage. It is now required, and the deploy fails on the missing variable instead.
* **The migration is a one-shot service every other service depends on**, rather than a step in the API's entrypoint. It needs `DATABASE_ADMIN_URL`, and the API must never have a reason to hold that — a request served by the admin role is a request with no RLS (§6). `service_completed_successfully` then means a failed migration stops the deploy instead of leaving an API running against a schema it does not match. **No seed**: `db:seed` writes example orgs with a published password.
* **Backups go to a second bucket with a second token.** If the media credential and the backup credential were one, an API compromise would take the recovery path with it. That is also why the backup container is the only one not given `env_file: .env` — it gets six variables and none of the app's.
* **`ci-web.yml` gained an `infra` job.** The prod compose file, the Caddyfile and the two shell scripts are the parts of the system that are otherwise only exercised in production, which is the worst place to find a typo in them. It validates rather than deploys: `compose config`, `caddy validate`, `shellcheck`.

**One thing M6 does not close.** The plan's own §3.3 has the worker sharing a droplet with the API through M6 and split before M7; `WORKER_CPUS` (0.8 by default) is the interim mitigation and not a fix — a long export will still make the API slow on one vCPU. The runbook's §10 lists that alongside the other known gaps: no email provider, no quotas, and a single Postgres whose recovery plan is the nightly dump.

**M7 as built.** The gate D7 said would decide whether an untrusted signup is safe now exists: a tenant's spend is bounded, their storage is collected, and the abuse routes around both are closed. `apps/api` gained `quota.ts`, `retention.ts`, `mail.ts`, `http/rate-limit.ts` and one migration; the worker gained a nightly sweep task; `apps/web/src/auth/` gained the Usage dialog and the password-reset screens. **No copied view was touched** — `ui-drift.sh` still reports 35 files current, which is the same check M4 and M5 passed.

Nine things are worth recording.

* **The meter is transcription minutes, and it is an append-only ledger rather than a counter.** `usage_events` deliberately has **no foreign key to `videos`**: if it cascaded, a tenant at their monthly limit could delete a video and get the month back, and every other limit would become advisory. Storage is the opposite shape — a *level*, summed from `videos.size_bytes` + `exports.size_bytes` — because "storage used" has to fall when a user deletes a project, which is the behaviour they expect from the words. GPT analysis is not metered separately: its cost is proportional to the transcript, which is proportional to the minutes already counted, so a second meter would only track the first.
* **The upload quota is checked twice, and only the second one is enforcement.** The ticket is issued against a size the *browser* claims, which is the only number available before any bytes move — so it is checked again at completion, against the object that actually arrived, from the `HeadObject` the completion already makes. A client that asks for a 100-byte ticket and PUTs 10 GB is refused there and the object is deleted with the refusal. Refusing early is worth more than refusing accurately; doing both is why it happens twice.
* **A quota is 402 and a rate limit is 429**, and the split is not pedantry: retrying a 429 works and retrying a 402 never will, so a client that cannot tell them apart either hammers a wall or gives up on something that would have succeeded. Both leave as the `{ error }` shape the copied views already render, so no view learned that quotas exist.
* **Signing up again was the hole under everything else.** A new org is a fresh monthly allowance for the price of a form submission, which makes every limit above it decorative. `QUOTA_MAX_ORGS_PER_USER` (3) closes it, counting *owned* orgs rather than memberships — being invited into ten organizations is ordinary collaboration and costs nothing.
* **The active-job cap found a real bug on its first run.** Cancelling an export marked the `exports` row and left its `jobs` row saying `queued` forever. Nothing read that value, so nothing was visibly wrong — until something counted it, at which point every cancelled export permanently consumed a slot of the tenant's budget. The cap did not cause it; it was the first thing to look. Its default also moved from 5 to 25 for a related reason: importing a semester of lectures is twenty extract jobs, and a limit an honest batch import trips is a bug report, not a defence.
* **Source video does not expire by default; exports do.** Plan §9 asks for a retention window that is honoured, and the sweep honours whatever is set — but the platform default for source media is *off*, because deleting a tenant's uploads on a timer they never chose is not a default anyone should get by accident, and cost is already bounded by the storage quota. Exports are the opposite: derived data, where expiry costs a re-export, so they get a real default (14 days) and are the one thing that finally writes M2's `download_expires_at`. An expired export keeps its history row in a status no copied view knows, which `getExportStatusBadgeClassName` renders as a plain badge with nothing to click — a greyed-out fact rather than a link to a 404.
* **The orphan sweep's grace period absorbs two different races, and the second one was found by running it.** The obvious one is an object written seconds before its row commits. The other is that the object store's clock is not the API's — MinIO stamps `LastModified` tens of milliseconds *ahead* of `Date.now()` here, ordinary container drift, and a sweep comparing them without slack would be deciding an object's fate on which machine was fast.
* **Suspension stops spend, not access.** A suspended org cannot upload, transcribe or export; it can still read, play back, download what it already has, and delete. A cost control that also holds a tenant's data hostage is a different thing wearing the same name.
* **The email provider stopped being a decision.** §10 listed it as undecided since M3, M4 shipped around it, and what was actually blocking was picking a vendor — not writing the code. `mail.ts` takes a driver (`none` | `log` | `resend`, no SDK, one `fetch`), and password reset exists exactly where mail does: `/api/config` reports whether it is configured, and the SPA renders the link only then. With no provider there is no link, no form and no route — the same refusal D7 makes about the desktop key UI, rather than a form that silently fails.

**Verified locally end to end**, against the real API, Postgres and MinIO: the five suites pass (85 tests), including the ways round a quota — an understated file size, a video deleted to refund its transcription, an org created to reset the month — and the sweep purging an abandoned upload, expiring a finished export's object while keeping its row, collecting an object no row points at while sparing one still settling, and honouring a retention window only once one is set.

**What M7 deliberately does not do.** There is no billing, no plan tier and no self-service upgrade: a tenant who needs more asks, and an operator writes one row (runbook §10). That is the right amount of machinery for a product that is still deciding what it charges for, and the schema is where a plan column would go when it is not.

### 7.1 Keeping the two UIs in sync

This is the cost of §1.1, and the whole plan's design constraint (§0) depends on paying it.

**The port is one-way. `src/` is upstream; `apps/web/src/` is downstream.** A UI change lands on desktop first and is then ported forward. Web-only changes to a copied view are a bug unless they are a §4 forced deviation — "while I was in there" edits are how the two apps stop being the same product.

**Every copied file carries a provenance header:**

```ts
// PORTED FROM: src/views/LessonSegmentsView.tsx @ 16d83e5
// DEVIATIONS: D2 (presigned playback URL), D5 (no output directory)
// Sync with `scripts/ui-drift.sh` — do not edit for web-only reasons.
```

The commit SHA is what the file was last synced at, not when it was copied — update it whenever you port a change forward, including a no-op re-sync.

**`scripts/ui-drift.sh`** walks those headers and, for each, runs `git log <sha>..HEAD -- <upstream path>`. Any upstream commit newer than the recorded SHA is unported drift, printed as a file list with the offending commits. It exits non-zero when drift exists and runs in `ci-web.yml`, so a desktop UI change that nobody ported shows up as a failing web build rather than as two apps that quietly stopped matching.

It deliberately reports *whether* upstream moved, not a textual diff — the files legitimately differ (that is the point of the deviations), so a line-level diff is unreadable, while "this file changed upstream and you haven't looked" is exactly the signal wanted.

**Pending desktop→web ports.** Desktop UI work that is planned or landed but deliberately *not* mirrored here yet is docked in [`docs/desktop-ui-optimizations-plan.md`](./desktop-ui-optimizations-plan.md) §4. `scripts/ui-drift.sh` flags these against the copied files once they land upstream.

*The first three — dark-only theme, sticky lesson preview, the AI prompt's timeline-context toggle — landed on desktop at `dad013b` and were ported forward the same day.* **The discipline worked exactly as designed, which is the first evidence it does:** the drift check failed on five files, `git diff <sha>..HEAD` on each said what to carry over, and the ports applied mechanically apart from two hunks that touched the key UI D7 had already removed — a rejection that is the *correct* answer, not a merge conflict to resolve. The timeline conversion needed no `apps/api` counterpart after all: it ended up entirely on the frontend, so `lib/timeline.ts` is a straight copy. The one flagged risk (a sticky `top-0` breaking if the web app had introduced its own scroll container) did not materialise — `AppShell`'s row is in normal flow and the window still scrolls.

**The one thing that makes this workable:** the desktop UI is essentially finished. The drift check is guarding against occasional fixes, not a parallel development stream. If desktop UI work does pick up again, revisit §1.1 — at that point the shared-package restructure starts paying for itself.

**What this milestone must *not* touch:** anything the desktop app builds from — `src/`, `src-tauri/`, `index.html`, `package.json`, `tsconfig*.json`, `vite.config.ts`, `components.json`, `.github/workflows/release.yml`. `eslint.config.js` and `.github/workflows/ci.yml` gain path scoping only. `git diff --stat` on the M1 branch is the check, and it should list nothing outside `apps/`, `scripts/ui-drift.sh`, `docs/`, and those two files.

---

## 8. Security — immediate actions

**The droplet's root password was pasted into a chat transcript and must be treated as compromised.** Before anything else:

1. Rotate the root password via the DigitalOcean web console (not over SSH, not into a chat).
2. Add an SSH key; set `PasswordAuthentication no` and `PermitRootLogin prohibit-password` in `sshd_config`.
3. Create a non-root sudo user for deploys; stop using `root` day-to-day.
4. `ufw`: allow only 22 (ideally IP-restricted), 80, 443. **Postgres must never be exposed publicly** — bind it to the Docker network / localhost only, never `0.0.0.0`.
5. `fail2ban` on SSH.

Ongoing: strong Postgres password and a separate least-privilege app role (no `BYPASSRLS`); auth session secret and OpenAI key held in the droplet's env file, never in the repo and never in the deploy pipeline; automated Postgres backups to R2; TLS via Caddy + Let's Encrypt.

M6 delivers the last three of those: `infra/docker/compose.prod.yml` publishes no port for Postgres, `/opt/coursecut/.env` is created by hand on the droplet and is the only place production secrets exist (Actions holds a registry token and a deploy key, nothing else), and the `backup` service dumps nightly to a **second** R2 bucket with a **second** token — so an API compromise cannot reach the recovery path. Step-by-step in [`docs/web-deploy-runbook.md`](./web-deploy-runbook.md).

---

## 9. Web privacy policy (the honest version)

The desktop guarantee cannot be offered here, so state the real one plainly and put it in the product UI, not just a legal page:

* Uploaded video is stored in object storage we control (Cloudflare R2), encrypted at rest, isolated per tenant by RLS and key prefix.
* Video is **never** sent to any third party. As on desktop, only **extracted audio** goes to Whisper and **transcript text** goes to GPT-5.5 — nothing else leaves our infrastructure.
* Users can delete a project and have its objects purged; define a retention window and honour it.
* Logs carry paths, ids, and error codes only — never transcript text or file contents (this rule carries over from desktop unchanged).

One more thing users must be told plainly, now that the key is ours (D7): **their transcripts are processed under our OpenAI account, not theirs.** Desktop's BYOK made that the user's own relationship with OpenAI; here it is ours, so the OpenAI data-handling terms that apply are the ones on our account. Say so in the same place as the rest of this list.

**Where it says it (M7).** All of the above is in the product, not only here: the short version on the sign-up screen, before anyone uploads anything, and the full list in the Usage dialog beside the numbers it refers to. The retention figures in it come from the server rather than from a constant in the page, so the statement cannot promise a window the sweep is not running.

Of the three questions this section left for M7, two are answered — the retention period (exports 14 days, source kept until deleted and per-org overridable) and per-org storage/compute quotas (§7's *M7 as built*). **ToS covering other people's content sitting on our infrastructure is still unwritten**, and is the one item here that is a document rather than code.

---

## 10. Decisions

### Settled — with what was rejected and why

Recorded so these aren't relitigated, and so a future reader knows the alternatives were considered rather than missed.

| Decision | Rejected | Why |
|---|---|---|
| Same repo, desktop left in place, `apps/web` added alongside | Separate repo / fork | One repo keeps the desktop original one `git log` away, which is what makes the drift check (§7.1) possible at all |
| `apps/web` gets its **own copy** of the UI | Shared `packages/ui` compiled by both | Extracting shared UI rewrites a shipping app's build and release pipeline for a guarantee we can get by process (§1.1). Cost: real drift risk, mitigated by §7.1 |
| `apps/web` installs standalone | npm workspaces at the repo root | A workspace root changes how the desktop app installs and builds — the exact risk being avoided |
| Plain Postgres | Self-hosted Supabase | ~8 containers, ≥4 GB before any video work, and `apps/api` made most of the bundle redundant |
| Cloudflare R2 | DO Spaces, AWS S3, self-hosted MinIO | Egress dominates cost at ~4:1 read/store ratio (§3.4). S3 disqualified by DO-hosted compute; MinIO on the droplet means no replication and a full disk |
| Vite SPA | Next.js | App Router pushes toward RSC and a view-tree restructure, against the "same views" constraint |
| Postgres-backed queue (graphile-worker) | Redis / BullMQ | One less service to secure, patch and back up, for no capability we need |
| SSE for progress | WebSockets, Supabase Realtime | Progress is one-directional; no second service needed |
| Postgres RLS via `SET LOCAL` | App-layer scoping only | One forgotten `WHERE` becomes a cross-tenant leak |
| Web scope in its own doc (this file) | Editing `docs/PRD.md` | Desktop's local-first invariant must stay documented and enforced (§0) |
| **Platform-owned OpenAI key** (D7) | BYOK per org, as desktop | Product decision: web users don't bring a key. Removes the whole key-management surface — no storage, no encryption, no key UI — at the cost of absorbing API spend, which makes M7's quotas gate the first untrusted signup |
| Denormalized `org_id` + composite FKs | Joining up to `projects` in each policy | Single-column policies stay fast and readable; the composite FK makes a child/parent org mismatch unrepresentable, which the policy itself cannot check |
| `text` ids, not `uuid` | UUID columns with `::uuid` casts in policies | `better-auth` mints non-UUID ids, and desktop already treats ids as opaque TEXT |
| Drizzle schema in `apps/api`, not `infra/postgres/` | §2's original layout | It is TypeScript that `apps/api` and `apps/worker` import; `infra/` keeps only genuine infrastructure (`compose.yml`) |

### Open

| Question | Leaning |
|---|---|
| ~~`better-auth` vs. roll-your-own~~ | **Settled at M3: the library.** Its organization plugin covers the org/membership model as advertised, and the session row it maintains (`active_organization_id`) is what `withOrg()` pins. No custom crypto anywhere in `apps/api` |
| ~~Transactional email provider (password reset, invites)~~ | **Dissolved at M7, not decided.** `mail.ts` takes a driver (`none`/`log`/`resend`) so the vendor is a deployment variable, and Resend needs one `fetch` rather than an SDK. Password reset exists wherever mail is configured and does not exist at all where it is not. Picking a provider is now an operator step in the runbook, and Postmark or SES is a branch in one file |
| ~~Per-org quota shape, now that spend is ours (D7)~~ | **Settled at M7: minutes of audio transcribed per org per calendar month**, plus stored bytes as a level and a queued-job cap for fairness. Analysis is not metered separately — its cost tracks the minutes. No longer invite-only on this account |
| Whether §7.1's drift discipline actually holds | Unproven — it is process, not structure. Re-open §1.1 if desktop UI development restarts in earnest |
| Worker on same droplet initially | Acceptable through M6; split before real load, or the first long export starves the API on a single vCPU. Still open — M7 did not move it, and `WORKER_CPUS` remains the mitigation |
| ~~Retention window~~ | **Settled at M7.** Exports expire after 14 days (derived data — expiry costs a re-export); source video is kept until deleted, per-org overridable. The sweep honours whatever is set, and the Usage dialog states whichever is in force |
| Pricing, plan tiers and what a paid ceiling looks like | Genuinely open, and deliberately not built. M7's limits are operator-set rows, which is the right amount of machinery until there is a price |
| ToS covering other people's content on our infrastructure | Still open. The product-side statement §9 asked for is now in the UI (sign-up and the Usage dialog); the legal document is not written |
