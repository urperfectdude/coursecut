# apps/stepcut-worker — the graphile-worker queue consumer
# (docs/stepcut-plan.md).
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
# Phase 1's worker ran a single throwaway `ping` task and touched no video, so
# this image originally had no ffmpeg and no scratch volume (plan decision 4).
# Phase 5 (§8: "Templates & render") added the real `render` task
# (`src/ffmpeg.ts`, `src/tasks/render.ts`) without this file being updated to
# match — fixed here, mirroring `worker.Dockerfile`'s ffmpeg stage and scratch
# directory, plus a font for `drawtext` that `src/env.ts`'s own
# `titleCardFontPath` comment already warned production would need.

# ffmpeg, pinned — same source, same reasoning as `worker.Dockerfile`: a
# server re-encoding other people's video should not change encoder version
# because an image rebuilt on a Tuesday.
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

FROM node:22-alpine

COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/

# `drawtext` (title cards, Phase 5) needs a resolvable font file — Alpine
# ships none by default, and `src/ffmpeg.ts`'s `buildTitleCardFilter` only
# passes `fontfile` when `TITLE_CARD_FONT_PATH` is set, so an unset one here
# would fail every render's title card rather than degrading gracefully.
# `ttf-dejavu` is a small, standard Alpine package; the WOFF-free `.ttf` is
# all `drawtext` needs.
RUN apk add --no-cache ttf-dejavu

WORKDIR /app

# Both installs, manifests first so neither is invalidated by a source change.
COPY stepcut-api/package.json stepcut-api/package-lock.json ./stepcut-api/
RUN cd stepcut-api && npm ci --omit=dev && npm cache clean --force

COPY stepcut-worker/package.json stepcut-worker/package-lock.json ./stepcut-worker/
RUN cd stepcut-worker && npm ci --omit=dev && npm cache clean --force

COPY stepcut-api/ ./stepcut-api/
COPY stepcut-worker/ ./stepcut-worker/

# Scratch space for a render job's source video and cut segments. Same
# parent-not-leaf mounting rule as `worker.Dockerfile`'s `/var/lib/coursecut`
# — `clearScratch()` removes and recreates the scratch root at startup, which
# needs a writable parent; mounting `compose.prod.yml`'s volume directly at
# `WORKER_SCRATCH_DIR` would make that parent root-owned and crash-loop the
# worker on EACCES. `/var/lib/stepcut`, not `/var/lib/coursecut` — the two
# products' scratch trees must never collide on the same droplet.
RUN mkdir -p /var/lib/stepcut && chown node:node /var/lib/stepcut

USER node

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    FFPROBE_PATH=/usr/local/bin/ffprobe \
    WORKER_SCRATCH_DIR=/var/lib/stepcut/scratch \
    TITLE_CARD_FONT_PATH=/usr/share/fonts/dejavu/DejaVuSans.ttf

WORKDIR /app/stepcut-worker

# PID 1 for the same reason as the API: `src/main.ts` closes the pool and
# stops the runner on SIGTERM.
CMD ["node", "--import", "tsx", "src/main.ts"]
