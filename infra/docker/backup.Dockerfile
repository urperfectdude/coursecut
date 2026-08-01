# Nightly Postgres backups to object storage (plan §8: "automated Postgres
# backups to R2 before M7").
#
#   docker build -f infra/docker/backup.Dockerfile -t coursecut-backup infra/docker/
#
# The one image here whose context is `infra/docker/` rather than `apps/`,
# because all it contains is `backup.sh`.
#
# `postgres:16-alpine` is the base rather than a slimmer one so that `pg_dump`
# is **the same major version as the server**. A dump taken by an older client
# against a newer server is refused outright, and the failure mode of the
# reverse — a newer client, older server — is worse, because it succeeds and
# produces something the server cannot always restore.

FROM postgres:16-alpine

# aws-cli, because R2 speaks S3 and this is the one place in the stack that
# writes to a *different* bucket with *different* credentials from
# `apps/api`'s. Doing it with the app's storage module would mean handing the
# app's code the backup bucket's token, which is exactly the coupling the
# separate bucket exists to prevent.
#
# coreutils for GNU `date`: the script needs relative dates ("30 days ago") to
# work out what to prune and when to next run, and BusyBox's `date` does not
# do arithmetic. Getting that wrong silently is a retention policy that either
# deletes nothing or deletes everything.
RUN apk add --no-cache aws-cli coreutils

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Runs as `postgres` (uid 70, present in the base image) rather than root: this
# container needs a network socket and a temp file, nothing else.
USER postgres

ENTRYPOINT ["/usr/local/bin/backup.sh"]
