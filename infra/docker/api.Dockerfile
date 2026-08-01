# apps/api — the Hono API (plan §3.2).
#
#   docker build -f infra/docker/api.Dockerfile -t coursecut-api apps/
#
# **Build context is `apps/`, not the repo root.** That is deliberate and it is
# the same rule the worker's Dockerfile follows: nothing under `src/` or
# `src-tauri/` is reachable from this build, so no layer can copy the desktop
# tree and no `npm ci` here can resolve against the desktop app's node_modules
# (plan §0). `apps/.dockerignore` covers the rest.
#
# No compile step, because there is nothing to compile: `apps/api` runs its
# TypeScript through `tsx`, exactly as it does in development, so the image and
# a developer's machine execute the same files. `tsx` is a runtime dependency
# here rather than a dev one for that reason.

FROM node:22-alpine

# Not strictly required — the API shells out to nothing — but `pg_isready` and
# a psql client in the running container is what turns "the database is
# unreachable" from a guess into a one-line check during an incident.
RUN apk add --no-cache postgresql16-client

WORKDIR /app/api

# Manifests first: the install layer is then cached across every change that
# is not a dependency change, which is almost all of them.
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# `drizzle/` comes along because the migrate one-shot in `compose.prod.yml`
# runs from this same image and reads the .sql files out of it.
COPY api/ ./

# Drop privileges. `node` exists in the base image; nothing here writes to the
# filesystem, so root ownership of the copied files is fine and correct.
USER node

ENV NODE_ENV=production

EXPOSE 3000

# `node --import tsx` rather than the `tsx` CLI, so this process is PID 1
# instead of its parent. That matters: `server.ts` closes the SSE listener and
# the connection pool on SIGTERM, and a relayed signal is one more thing
# between `docker compose down` and a clean shutdown.
CMD ["node", "--import", "tsx", "src/server.ts"]
