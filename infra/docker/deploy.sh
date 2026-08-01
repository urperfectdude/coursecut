#!/usr/bin/env bash
# Rolls the droplet forward (or back) to one image tag.
#
#   ./deploy.sh <tag>      # usually a commit SHA
#   ./deploy.sh            # re-apply whatever IMAGE_TAG already says
#
# Runs **on the droplet**, from `/opt/coursecut`. The deploy workflow copies
# this file, `compose.prod.yml` and `Caddyfile` here and then runs it over SSH,
# which means the same command an operator types by hand during an incident is
# the one CI runs — there is no deploy logic that only exists in a YAML file.
#
# It never touches `.env`, apart from the one line naming the tag. Secrets are
# the droplet's (plan §8), and a deploy that could rewrite them would be a
# deploy that could leak them.

set -euo pipefail

cd "$(dirname "$0")"

COMPOSE=(docker compose -f compose.prod.yml)

if [ ! -f .env ]; then
  echo "no .env in $(pwd) — copy .env.example, fill it in, chmod 600" >&2
  exit 1
fi

if [ $# -ge 1 ]; then
  tag="$1"
  # Rewritten in place so `.env` stays the single answer to "what is
  # deployed?" — including after a reboot, when Docker restarts the stack from
  # this file and nothing else.
  if grep -q '^IMAGE_TAG=' .env; then
    sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${tag}|" .env
  else
    printf '\nIMAGE_TAG=%s\n' "$tag" >> .env
  fi
  echo "==> IMAGE_TAG=${tag}"
fi

echo "==> pulling"
"${COMPOSE[@]}" pull

# `--wait` is what makes this a deploy rather than a hope: it blocks until
# every service with a healthcheck is healthy and fails the command if one
# never gets there. Combined with `service_completed_successfully` on the
# migrate one-shot, a failed migration stops the deploy instead of leaving an
# API running against a schema it does not match.
echo "==> starting"
"${COMPOSE[@]}" up -d --wait --remove-orphans

# Old images accumulate fast — three per deploy, each a few hundred MB, on a
# 50 GB disk. Only dangling ones: a tagged older image is exactly what a
# rollback needs, and pruning those would make "deploy the previous SHA"
# require a rebuild.
echo "==> pruning dangling images"
docker image prune -f >/dev/null

echo "==> deployed"
"${COMPOSE[@]}" ps
