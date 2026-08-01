#!/bin/sh
# Dumps the database to object storage on a schedule, and prunes old dumps.
#
# Run as a long-lived container (see `compose.prod.yml`) rather than a host
# cron job, for the same reason everything else here is a container: the thing
# that has to keep working after a droplet rebuild should be described in the
# repo, not in a crontab someone remembers to recreate.
#
# Environment (all from the droplet's env file):
#
#   BACKUP_DATABASE_URL   what to dump. The **admin** role — a dump taken as
#                         the RLS-scoped app role would silently contain no
#                         tenant rows at all, which is the worst possible
#                         backup: one that restores cleanly and is empty.
#   BACKUP_S3_*           endpoint, bucket, credentials. A *different* bucket
#                         and a *different* token from the media bucket, so
#                         the credential the API and worker hold cannot read
#                         or delete the backups.
#   BACKUP_RETENTION_DAYS how long to keep dumps (default 30)
#   BACKUP_HOUR_UTC       hour of day to run (default 03)
#
# Restore is in `docs/web-deploy-runbook.md` — a backup nobody has restored is
# a hypothesis, so that section is written to be followed verbatim.

set -eu

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_HOUR_UTC="${BACKUP_HOUR_UTC:-03}"
PREFIX="${BACKUP_S3_PREFIX:-postgres}"

log() {
  echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

require() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    log "missing required environment variable $1"
    exit 1
  fi
}

require BACKUP_DATABASE_URL
require BACKUP_S3_ENDPOINT
require BACKUP_S3_BUCKET
require BACKUP_S3_ACCESS_KEY_ID
require BACKUP_S3_SECRET_ACCESS_KEY

export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
# R2 wants a region and does not care which; "auto" is what its own
# documentation uses and what `apps/api` is configured with.
export AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}"

s3() {
  aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 "$@"
}

# Custom format (`-Fc`), not plain SQL: it restores with `pg_restore`, which
# can reorder to satisfy dependencies, restore a single table, and skip
# ownership — none of which a plain dump can do when the roles on the new
# server are not the ones on the old.
dump_once() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  key="${PREFIX}/coursecut-${stamp}.dump"
  file="/tmp/coursecut-${stamp}.dump"

  log "dumping to ${key}"
  pg_dump --format=custom --no-owner --no-privileges \
    --file="$file" "$BACKUP_DATABASE_URL"

  size="$(wc -c < "$file")"
  # A dump that is implausibly small is the shape a permissions or
  # empty-schema failure takes, and it is the one failure a backup job must
  # not report as success. 4 KiB is far below any real dump of this schema and
  # far above an empty one.
  if [ "$size" -lt 4096 ]; then
    rm -f "$file"
    log "dump was only ${size} bytes — refusing to upload it"
    return 1
  fi

  s3 cp "$file" "s3://${BACKUP_S3_BUCKET}/${key}"
  rm -f "$file"
  log "uploaded ${key} (${size} bytes)"
}

# Pruning is done by listing and comparing dates rather than by a bucket
# lifecycle rule, so retention is one number in one file and does not depend on
# a console setting nobody can see from here.
prune() {
  cutoff="$(date -u -d "${RETENTION_DAYS} days ago" +%Y%m%d)"
  log "pruning dumps older than ${cutoff}"

  s3 ls "s3://${BACKUP_S3_BUCKET}/${PREFIX}/" | awk '{print $4}' | while read -r name; do
    [ -n "$name" ] || continue
    # coursecut-20260731T030000Z.dump → 20260731
    day="$(echo "$name" | sed -n 's/^coursecut-\([0-9]\{8\}\)T.*\.dump$/\1/p')"
    [ -n "$day" ] || continue
    if [ "$day" -lt "$cutoff" ]; then
      s3 rm "s3://${BACKUP_S3_BUCKET}/${PREFIX}/${name}"
      log "pruned ${name}"
    fi
  done
}

# `once` exists so the runbook's "prove the backup works" step is a command
# rather than a wait, and so an operator about to do something frightening can
# take a dump first.
if [ "${1:-}" = "once" ]; then
  dump_once
  prune
  exit 0
fi

log "started; daily at ${BACKUP_HOUR_UTC}:00 UTC, keeping ${RETENTION_DAYS} days"

while true; do
  now="$(date -u +%s)"
  next="$(date -u -d "today ${BACKUP_HOUR_UTC}:00:00" +%s)"
  # Recomputed every iteration rather than slept in 24h steps, so a restart
  # does not shift the schedule and a slow dump does not push tomorrow's later.
  [ "$next" -le "$now" ] && next=$(( next + 86400 ))
  log "next run in $(( next - now ))s"
  sleep "$(( next - now ))"

  # A failed backup must not kill the loop — tomorrow's attempt may well
  # succeed, and a container in a crash loop is a backup system that stopped
  # trying. It is loud instead.
  if ! dump_once; then
    log "BACKUP FAILED"
  fi
  prune || log "prune failed"
done
