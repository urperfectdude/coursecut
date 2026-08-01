# apps/worker — the ffmpeg job processor (plan §3.2, M5).
#
#   docker build -f infra/docker/worker.Dockerfile -t coursecut-worker apps/
#
# Context is `apps/` because this image needs **both** packages: the worker
# imports `apps/api`'s schema, storage, events and OpenAI modules directly
# (M5's first note), so `../api/src` has to be present and `apps/api`'s
# node_modules has to be where Node's resolution walks to from those files.
# Installing only `apps/worker`'s dependencies would leave a bare
# `import "drizzle-orm"` inside `apps/api/src` unresolvable — which is the
# whole reason the worker is its own package with its own install rather than
# a loose directory under `apps/`.

# ffmpeg, pinned. The desktop app fetches "latest" builds because a user
# reinstalling gets whatever is current anyway; a server that re-encodes other
# people's video should not change encoder version because an image rebuilt on
# a Tuesday. These are static binaries, so they run on Alpine with no runtime
# libraries behind them.
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

FROM node:22-alpine

COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/

WORKDIR /app

# Both installs, manifests first so neither is invalidated by a source change.
COPY api/package.json api/package-lock.json ./api/
RUN cd api && npm ci --omit=dev && npm cache clean --force

COPY worker/package.json worker/package-lock.json ./worker/
RUN cd worker && npm ci --omit=dev && npm cache clean --force

COPY api/ ./api/
COPY worker/ ./worker/

# Scratch space for a job's source video, extracted audio and per-segment cuts.
# Everything under it is transient: each job removes its own directory, and
# `clearScratch` wipes the tree at startup.
#
# The volume in `compose.prod.yml` mounts at `/var/lib/coursecut` — the
# **parent** of `WORKER_SCRATCH_DIR`, not the scratch directory itself. That is
# not a detail: `clearScratch` removes the scratch root and recreates it, and
# removing a directory requires write permission on its parent. Mounting the
# volume directly at the scratch path makes that parent the image's root-owned
# filesystem, and the worker dies on boot with EACCES. Mounting one level up
# puts the parent inside the volume, which Docker initializes with this
# directory's ownership — hence the chown.
RUN mkdir -p /var/lib/coursecut && chown node:node /var/lib/coursecut

USER node

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    FFPROBE_PATH=/usr/local/bin/ffprobe \
    WORKER_SCRATCH_DIR=/var/lib/coursecut/scratch

WORKDIR /app/worker

# PID 1 for the same reason as the API: the worker stops the runner, closes the
# progress listener and drains its pool on SIGTERM, and a job that is killed
# mid-encode instead leaves a `running` row for the next boot to reconcile.
CMD ["node", "--import", "tsx", "src/main.ts"]
