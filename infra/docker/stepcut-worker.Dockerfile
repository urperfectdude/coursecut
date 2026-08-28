# apps/stepcut-worker — the graphile-worker queue consumer
# (docs/stepcut-plan.md, Phase 1).
#
#   docker build -f infra/docker/stepcut-worker.Dockerfile -t stepcut-worker apps/
#
# Context is `apps/` because this image needs **both** packages: the worker
# imports `apps/stepcut-api`'s db client and env directly (plan decision 2 of
# docs/stepcut-plan.md's §2, mirroring `worker.Dockerfile`'s own note), so
# `../stepcut-api/src` has to be present and `apps/stepcut-api`'s node_modules
# has to be where Node's resolution walks to from those files. Installing only
# `apps/stepcut-worker`'s dependencies would leave a bare `import "pg"` inside
# `apps/stepcut-api/src` unresolvable.
#
# No ffmpeg stage and no scratch volume here (unlike `worker.Dockerfile`) —
# Phase 1's worker runs a single throwaway `ping` task and touches no video
# (plan decision 4). Both are added back in Phase 5 alongside the render task,
# mirroring `worker.Dockerfile`'s `mwader/static-ffmpeg` stage and its
# `/var/lib/coursecut` scratch directory at that point.

FROM node:22-alpine

WORKDIR /app

# Both installs, manifests first so neither is invalidated by a source change.
COPY stepcut-api/package.json stepcut-api/package-lock.json ./stepcut-api/
RUN cd stepcut-api && npm ci --omit=dev && npm cache clean --force

COPY stepcut-worker/package.json stepcut-worker/package-lock.json ./stepcut-worker/
RUN cd stepcut-worker && npm ci --omit=dev && npm cache clean --force

COPY stepcut-api/ ./stepcut-api/
COPY stepcut-worker/ ./stepcut-worker/

USER node

ENV NODE_ENV=production

WORKDIR /app/stepcut-worker

# PID 1 for the same reason as the API: `src/main.ts` closes the pool and
# stops the runner on SIGTERM.
CMD ["node", "--import", "tsx", "src/main.ts"]
