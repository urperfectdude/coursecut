# apps/web — the SPA, baked into the Caddy image that serves it.
#
#   docker build -f infra/docker/web.Dockerfile -t coursecut-web apps/
#
# One image rather than two (a static build plus a stock Caddy) because the
# bundle and the server that serves it deploy as a unit: a rollback should put
# back the exact assets that were serving before, and a shared volume
# populated by a one-shot is a way to get that subtly wrong.
#
# The Caddyfile is **not** baked in — it is bind-mounted from the droplet's
# `/opt/coursecut/Caddyfile` by `compose.prod.yml`, so a TLS or header change
# is a config reload rather than an image rebuild. See `infra/docker/Caddyfile`.
#
# No build arguments and no environment: production builds are always live
# against the real API. M1's in-memory mock sits behind `import.meta.env.DEV`
# and a dynamic import, so it is not in this bundle at all — there is nothing
# here for `VITE_API_MODE` to switch.

FROM node:22-alpine AS build

WORKDIR /app/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./

# `npm run build` is `tsc --noEmit && vite build` — the typecheck is part of
# the build on purpose, so an image can never be produced from source that CI
# would reject.
RUN npm run build

FROM caddy:2-alpine

COPY --from=build /app/web/dist /srv
