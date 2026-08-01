# CourseCut Web — deployment runbook

Companion to [`docs/web-app-plan.md`](./web-app-plan.md) §7 (M6) and §8. Everything the repo can express lives in `infra/docker/`; this file is the part that has to happen in a console, a DNS panel, or an SSH session — plus what to do when something breaks at 3am.

Nothing here touches the desktop app. `release.yml` and the `src/` + `src-tauri/` tree are untouched by every step below.

---

## What the repo already contains

| File | What it is |
|---|---|
| `infra/docker/api.Dockerfile` | `apps/api` on Node 22, running TypeScript through `tsx` |
| `infra/docker/worker.Dockerfile` | `apps/worker` + `apps/api`'s source, with ffmpeg 7.1 pinned |
| `infra/docker/web.Dockerfile` | the SPA, built and baked into a Caddy image |
| `infra/docker/backup.Dockerfile` + `backup.sh` | nightly `pg_dump` to object storage |
| `infra/docker/compose.prod.yml` | the stack: postgres, migrate, api, worker, caddy, backup |
| `infra/docker/Caddyfile` | TLS, the SPA, and the one reverse proxy |
| `infra/docker/.env.example` | the droplet's environment, annotated |
| `infra/docker/deploy.sh` | what runs on the droplet, by hand or over SSH |
| `.github/workflows/deploy-web.yml` | build → registry → deploy |

Build contexts are `apps/` for the three app images and `infra/docker/` for the backup image. The desktop tree is not reachable from any of them.

---

## 1. Before anything: the droplet (M0, plan §8)

Most of this is `infra/docker/bootstrap-droplet.sh`, which is idempotent and safe to re-run:

```sh
# generate the CI-only key first — this is what Actions will authenticate with
ssh-keygen -t ed25519 -C coursecut-deploy -N "" -f ~/.ssh/coursecut_deploy

scp infra/docker/bootstrap-droplet.sh root@<droplet>:/tmp/
ssh root@<droplet> "bash /tmp/bootstrap-droplet.sh '$(cat ~/.ssh/coursecut_deploy.pub)'"
```

It creates the `deploy` user with that key, installs Docker, sets `ufw` to 22/80/443 only, enables fail2ban, creates `/opt/coursecut`, and *stages* the sshd hardening.

Three things it deliberately leaves to you:

1. **Rotate the root password** in the DigitalOcean console — over the web, not over SSH, and never into a chat window.
2. **Restart sshd yourself**, after proving a key session works from a second terminal. The script writes the config and stops; only a human can confirm they still have a way back in.
   ```sh
   ssh -i ~/.ssh/coursecut_deploy deploy@<droplet> true   # must succeed first
   ssh root@<droplet> 'sshd -T | grep passwordauthentication; systemctl restart ssh'
   ```
3. Verify the host key fingerprint against the DigitalOcean console before trusting it (it becomes `DEPLOY_KNOWN_HOSTS` in §5).

**Why the hardening is a drop-in file and not an edit to `sshd_config`:** Ubuntu's cloud image has `Include /etc/ssh/sshd_config.d/*.conf` on line 12 and ships `50-cloud-init.conf` with `PasswordAuthentication yes`. OpenSSH takes the **first** value it sees, so anything appended to the main file loses — silently. The script writes `00-coursecut-hardening.conf`, which sorts ahead of it. Check with `sshd -T | grep passwordauthentication`, never by reading `sshd_config`.

Postgres is never in the firewall list. `compose.prod.yml` publishes no port for it, so it is reachable only on the compose network — `ufw` is the second lock, not the first.

---

## 2. DNS

One A record for the domain in `APP_DOMAIN`, pointing at the droplet's IPv4 (and AAAA if you have IPv6). **Do it before the first deploy** — Caddy asks Let's Encrypt for a certificate as soon as it starts, and a name that does not resolve yet burns an attempt against a rate limit.

If the domain is on Cloudflare, set the record to **DNS only** (grey cloud) for the first issuance. Proxied records make the HTTP-01 challenge Cloudflare's problem rather than Caddy's, and the failure looks like a certificate error rather than a configuration one. You can turn the proxy on afterwards — with SSL/TLS set to **Full (strict)**, since Flexible loops against Caddy's own http→https redirect — and then re-check that the SSE progress stream still arrives continuously rather than in one lump at the end, which is the thing edge buffering breaks.

**On a free DuckDNS subdomain instead**, which is what this deployment uses (`coursecut.duckdns.org`), point it at the droplet with one request rather than the web form — the form defaults to *your* IP, not the server's:

```sh
curl "https://www.duckdns.org/update?domains=coursecut&token=<duckdns-token>&ip=<droplet-ip>"   # prints OK
dig +short coursecut.duckdns.org @1.1.1.1                                                       # confirm
```

DuckDNS is on the Public Suffix List, which is the reason to prefer it over `sslip.io` or `nip.io`: each `*.duckdns.org` name gets its own Let's Encrypt rate-limit bucket, while the other two share one across every user of the service and fail issuance unpredictably. There is no Cloudflare zone in this arrangement, so there is no proxy to turn on — and R2 is unaffected either way, since presigned URLs go straight to `<account>.r2.cloudflarestorage.com`.

---

## 3. Cloudflare R2

Two buckets, deliberately (plan §3.4, and §8's separation of the backup path):

| Bucket | Holds | Who has credentials |
|---|---|---|
| `coursecut-media` | source video, extracted audio, exports | api + worker |
| `coursecut-backups` | `pg_dump` output | the backup container only |

1. Create both in the Cloudflare dashboard → R2. Same account, so the same endpoint host serves both.
2. Note the S3 endpoint: `https://<account-id>.r2.cloudflarestorage.com`. It has no bucket in it — the bucket is a separate variable, and a hostname must never reach the database or the browser (plan §3.4 rule 1 and 3).
3. Create **two API tokens**, each *Object Read & Write* scoped to *one* bucket. Not an account-level token: the media credential lives in a container that runs other people's video through ffmpeg, and it should be able to do nothing but read and write objects in one bucket. R2 shows the access key id and secret once.
4. Fill `S3_*` and `BACKUP_S3_*` in `/opt/coursecut/.env` accordingly.
5. CORS on the media bucket — the browser uploads straight to R2, so without it every upload fails in the browser while working from `curl`:
   ```sh
   cd apps/api
   # with APP_URL and the media bucket's S3_* in the environment
   npm run storage:cors            # applies GET/PUT/HEAD + ETag for APP_URL's origin
   npm run storage:cors -- --show  # read it back
   ```
   Run it from anywhere with those variables set — your laptop is fine, it is one API call. The backup bucket needs no CORS; no browser touches it.

   Locally this command is a no-op that says so: MinIO does not implement `PutBucketCors` and its CORS is server-wide in `infra/postgres/compose.yml`.

---

## 4. Container registry — nothing to create

Images go to **`ghcr.io/<owner>/coursecut-{api,worker,web,backup}`**, which needs no account, no token and no setup step: the build authenticates with the `GITHUB_TOKEN` Actions mints for the run, and the deploy job hands that same short-lived token to the droplet for its `docker pull`, then logs out.

That keeps M6's actual requirement — *no long-lived registry credential is ever stored on the droplet* — while removing the two DigitalOcean API tokens the original plan needed. `REGISTRY=ghcr.io/<owner>` goes in the droplet's `.env`; there is no `REGISTRY` Actions secret, because the workflow derives it from `github.repository_owner`.

The packages inherit the repository's visibility. On a public repo they are public, which is harmless — they contain no secrets, only the built app — but it does mean anyone can pull them. Make the packages private in *Settings → Packages* if that matters; the deploy still works, because the token it uses is authenticated either way.

---

## 5. GitHub Actions secrets

`deploy-web.yml` needs five, and none of them is a production application secret — those live only on the droplet (plan §8). There is no registry secret: ghcr.io uses the automatic `GITHUB_TOKEN` (§4).

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | droplet IP or hostname |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | private half of a key generated **for CI only** (`ssh-keygen -t ed25519 -C coursecut-deploy -N ""`), public half in `deploy`'s `authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <droplet-ip>`, verified against the console's host key fingerprint |
| `APP_DOMAIN` | the public domain, used by the post-deploy health check |

`DEPLOY_KNOWN_HOSTS` is what makes the SSH step refuse to hand a registry token to whatever answers on port 22. Capture it from a network you trust and check it against the fingerprint DigitalOcean's console recovery shell prints.

---

## 6. First deploy

```sh
# on the droplet, as deploy
cd /opt/coursecut
# copy .env.example over from the repo (or scp it), then:
cp .env.example .env && chmod 600 .env && $EDITOR .env
```

Fill in every blank. **`openssl rand -hex 32` for the two database passwords** — hex, not base64, because those passwords are embedded in `postgres://` URLs and base64's `+`, `/` and `=` are either reserved there or silently mangled, which surfaces as an authentication failure with a password that looks correct in the file. `AUTH_SECRET` is not in a URL, so `openssl rand -base64 48` is fine for it.

`APP_DB_PASSWORD` and the password inside `DATABASE_URL` must match — `db:bootstrap` sets the role's password from the first and the API connects with the second, so a mismatch is an API that starts and then cannot log in to its own database.

**Comments belong above a value, never after it.** `S3_ENDPOINT=  # fill me in` is read as the literal string `# fill me in` by some env-file parsers rather than as empty, and a placeholder that is technically a value fails much later and much more confusingly than a blank one.

Then push to `main` (or run the workflow by hand). The workflow builds the four images, pushes them, copies `compose.prod.yml`, `Caddyfile`, `deploy.sh` and `.env.example` to `/opt/coursecut/`, and runs `deploy.sh <sha>`.

To do the same by hand:

```sh
cd /opt/coursecut
echo "$DO_TOKEN" | docker login registry.digitalocean.com -u unused --password-stdin
./deploy.sh <tag>
```

### There is no seeded user

`compose.prod.yml` runs `db:bootstrap` and `db:migrate`, never `db:seed` — that writes example orgs with a published password. The first real account is created by signing up in the browser, which lands on M4's "create an organization" screen and gives that user their own org. Until M7's quotas exist the plan says treat the deployment as **invite-only**: every subsequent user should arrive through the Members dialog's invitation link, because the OpenAI spend is ours (D7).

---

## 7. Verifying a deploy

`deploy.sh` already blocks until every healthcheck passes, and the workflow then curls `/api/health` over TLS. Beyond that, the end-to-end check that actually proves M6 — run it once, by hand, after the first deploy:

1. `https://<domain>` serves the app and the certificate is valid.
2. Sign up; you land on the create-organization screen; create one.
3. Create a project, upload an MP4 from the browser. Watch `docker compose -f compose.prod.yml logs -f worker`: extract → transcribe → analyze.
4. The object landed under the org prefix:
   ```sh
   aws --endpoint-url "$S3_ENDPOINT" s3 ls "s3://$S3_BUCKET/" --recursive | head
   ```
5. Lessons appear; export one; the download link works.
6. Progress moved *during* the job rather than all at once at the end — that is the SSE path (D4) working through Caddy.
7. Take a backup on demand and confirm it is real:
   ```sh
   docker compose -f compose.prod.yml run --rm backup once
   ```

If (3) never starts, the usual cause is the worker: `docker compose logs worker`. If the upload fails in the browser but the API is healthy, it is R2 CORS (§3.5) — the browser console will say so explicitly.

---

## 8. Day-2 operations

All from `/opt/coursecut`.

```sh
docker compose -f compose.prod.yml ps                  # what is running
docker compose -f compose.prod.yml logs -f api worker  # follow
docker compose -f compose.prod.yml restart worker      # bounce one service
```

**Rollback.** Run the deploy workflow with `image_tag` set to an earlier commit's short SHA; it skips the build entirely and redeploys those exact images. By hand: `./deploy.sh <older-sha>`.

A rollback across a migration is not symmetric — migrations only go forward. If the bad deploy included one, roll back the images and then decide about the schema deliberately; the older code running against the newer schema is usually survivable, and restoring the database is §9.

**Rotating a secret.** Edit `/opt/coursecut/.env` and `./deploy.sh`. Rotating `AUTH_SECRET` signs everyone out. Rotating `APP_DB_PASSWORD` needs `DATABASE_URL` changed to match in the same edit — the next `migrate` run re-asserts the role's password from `APP_DB_PASSWORD`.

**Disk.** `docker system df`. Log rotation is configured (10 MB × 3 per service), and `deploy.sh` prunes dangling images. If the worker's scratch volume has grown, something died mid-job: the worker clears it at startup, so restarting it is the fix.

**Never prune `coursecut_caddy-data`.** It holds the certificates and the ACME account key; losing it means re-issuing, and Let's Encrypt rate-limits that.

---

## 9. Restoring the database

Do this once on a scratch database before you need it. A backup nobody has restored is a hypothesis.

```sh
# 1. what is there
docker compose -f compose.prod.yml run --rm --entrypoint sh backup -c '
  export AWS_ACCESS_KEY_ID=$BACKUP_S3_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$BACKUP_S3_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=auto
  aws --endpoint-url $BACKUP_S3_ENDPOINT s3 ls s3://$BACKUP_S3_BUCKET/postgres/'

# 2. stop everything that writes
docker compose -f compose.prod.yml stop api worker

# 3. pull the dump and restore it, as the admin role
docker compose -f compose.prod.yml run --rm --entrypoint sh backup -c '
  export AWS_ACCESS_KEY_ID=$BACKUP_S3_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$BACKUP_S3_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=auto
  aws --endpoint-url $BACKUP_S3_ENDPOINT s3 cp s3://$BACKUP_S3_BUCKET/postgres/<file>.dump /tmp/r.dump &&
  pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$BACKUP_DATABASE_URL" /tmp/r.dump'

# 4. re-grant the app role, then start back up
docker compose -f compose.prod.yml run --rm migrate
docker compose -f compose.prod.yml up -d
```

Step 4 is not optional. The dump is taken `--no-owner --no-privileges`, so a restored database has the tables but not the app role's grants — and `migrate` (which runs `bootstrap` first) is what puts them back. Skipping it gives an API that connects and can read nothing, which looks exactly like a tenant-isolation bug.

**What a database restore does not restore:** the objects in R2. Video, audio and exports are not in the dump, and a restore to an older point leaves rows pointing at keys that may have been purged since. R2 object versioning is the answer if that matters.

There is a second-order version of that now the retention sweep runs (§11): a restore rolls the *database* back to last night, and the sweep has since deleted objects that the restored rows still point at. It also cuts the other way — rows restored for videos whose objects are gone will look like orphans on the next sweep, which is correct but irreversible. **Stop the worker before restoring**, and leave it stopped until you have looked at what came back.

---

## 10. Quotas, retention and suspension (M7)

Every limit is a platform default in `/opt/coursecut/.env` (see `.env.example`) with an optional per-org override in `org_settings`. Nothing here is self-service — there is no billing and no plan tier, so raising a tenant's ceiling is one `UPDATE` by an operator, on purpose.

```sh
# open a psql as the admin role (the app role cannot write these columns'
# table across orgs — RLS scopes it to whatever org is pinned)
docker compose -f compose.prod.yml exec postgres psql -U postgres coursecut
```

```sql
-- who is using what, this month
select o.slug,
       round(sum(u.quantity) / 60) as minutes_this_month
from organizations o
left join usage_events u
  on u.org_id = o.id
 and u.kind = 'transcription_seconds'
 and u.occurred_at >= date_trunc('month', now())
group by o.slug order by 2 desc nulls last;

-- and what they are storing
select o.slug,
       pg_size_pretty(coalesce(sum(v.size_bytes), 0)) as video,
       pg_size_pretty(coalesce(sum(e.size_bytes), 0)) as exports
from organizations o
left join videos v on v.org_id = o.id
left join exports e on e.org_id = o.id
group by o.slug;

-- raise one tenant's ceiling (null = fall back to the platform default)
insert into org_settings (org_id, transcription_minutes_limit, storage_bytes_limit)
values ('<org id>', 3000, 214748364800)
on conflict (org_id) do update
  set transcription_minutes_limit = excluded.transcription_minutes_limit,
      storage_bytes_limit         = excluded.storage_bytes_limit;

-- give one tenant a retention window (days; null or 0 = keep until deleted)
update org_settings set retention_days = 90 where org_id = '<org id>';

-- suspend an org: uploads, transcription and exports refuse with this reason.
-- Reads, downloads and deletes keep working — this is a cost control, not a
-- way to hold someone's data hostage.
update org_settings
   set suspended_at = now(), suspended_reason = 'unpaid invoice'
 where org_id = '<org id>';

-- and lift it
update org_settings set suspended_at = null, suspended_reason = null
 where org_id = '<org id>';
```

A refused request comes back as **402** with the message the user reads; a rate-limited one is **429**. If a tenant reports "it just says I am out of minutes", that is the quota and not a bug.

**The sweep.** The worker runs it nightly (`RETENTION_SWEEP_CRON`, 04:20 UTC by default) and logs one line per run. To run it now, or to see what it would do:

```sh
docker compose -f compose.prod.yml exec api npm run retention:sweep
docker compose -f compose.prod.yml logs worker | grep retention
```

It does four things per org: purges upload rows the browser abandoned, deletes finished exports past their download window (the history row stays, as `expired`), purges source video past the org's retention window *if one is set*, and deletes objects no row points at. The last one is the backstop for every best-effort object delete in the system, and it is the reason a failed `deletePrefix` after a project delete is survivable rather than a slow leak.

**Deleting a tenant.** An org owner does it from Usage & limits in the product, and the API's own hook purges the bucket prefix. For the cases that never reach a signed-in owner — an abandoned tenant, a spam signup, a request from someone locked out — there is an operator path:

```sh
docker compose -f compose.prod.yml exec api npm run org:purge -- <org id> <org id>
```

The id twice, because this is irreversible. It removes the objects first and the row second: the row is what makes the objects findable, so deleting it first would leave a bucket prefix nothing will ever collect (the sweep walks orgs that still exist).

---

## 11. Known gaps at M7

* **Worker and API share a droplet.** Plan §3.3 says split before real load. `WORKER_CPUS` (default 0.8) is the interim mitigation, not a fix — a long export will still make the API slow. This is now the oldest open item.
* **Single droplet, single Postgres.** The backup is the recovery plan; there is no replica and no failover.
* **Rate limiting is in-process.** Both limiters (the API's, keyed by user; `better-auth`'s, keyed by IP) hold their counters in memory. One API container, so that is correct today — but a restart forgives everyone, and running two API containers multiplies every limit by two. Move `better-auth`'s to `storage: "database"` and the API's to a shared store *before* scaling out, not after.
* **No billing.** Limits are operator-set rows; there is no plan, no card and no self-service upgrade. A tenant who needs more asks.
* **Email is optional and unset by default.** With `MAIL_DRIVER=none` there is no password reset anywhere in the product, which is deliberate but means account recovery is a support request. Set `MAIL_DRIVER=resend` and `MAIL_API_KEY` to change that; nothing else needs to change.
* **`storage:cors` has only been exercised against MinIO's refusal path.** The R2 branch is one `PutBucketCors` call, and §3.5's `--show` is how you confirm it landed. *(The live deployment's CORS was applied through the Cloudflare API instead — `PUT /accounts/{account}/r2/buckets/coursecut-media/cors`, same rule as `browserCorsRule` — so the S3 path is still unexercised against R2.)*
* **One R2 token currently serves both buckets.** §3's separation — a media credential that cannot read or delete the backups — is not in force on the live deployment: `S3_*` and `BACKUP_S3_*` hold the same account-wide key, so an API compromise reaches the recovery path. Deliberate and temporary, taken so the first deploy was not blocked on a second token. Closing it is two edits to `/opt/coursecut/.env` and a `./deploy.sh`, with no schema or code change:
  1. Narrow the existing token to `coursecut-media` (R2 → API → Manage API tokens → Edit → *Apply to specific buckets only*). The access key id and secret survive the edit.
  2. Create a second token scoped to `coursecut-backups`, and put its pair in `BACKUP_S3_*`.
