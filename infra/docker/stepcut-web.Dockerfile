# apps/stepcut — the StepCut SPA, baked into its own internal Caddy image.
#
#   docker build -f infra/docker/stepcut-web.Dockerfile -t stepcut-web apps/
#
# One image rather than two, for the same reason as `web.Dockerfile`: the
# bundle and the server that serves it deploy as a unit.
#
# **This container's Caddyfile is baked in, unlike `web.Dockerfile`'s**, which
# is bind-mounted from the droplet by `compose.prod.yml`. `stepcut-web` is
# internal-only — reached solely through the one shared edge Caddy, over the
# compose network, never bound to a host port (plan decision 5) — so there is
# no TLS or header config here for a droplet operator to reload; the only job
# left for this container's own Caddy is `file_server` + SPA fallback, which
# never changes without a rebuild anyway. See `stepcut/Caddyfile` (baked in
# from here — `infra/` is unreachable from this build's `apps/` context, so it
# lives beside the app instead of beside the edge Caddyfile) and the edge
# `infra/docker/Caddyfile`'s `{$STEPCUT_DOMAIN}` block, which owns TLS,
# HSTS/CSP headers and logging for the public response.
#
# No build arguments and no environment: production builds are always live
# against the real API (plan decision 11 — no mock mode in apps/stepcut).

FROM node:22-alpine AS build

WORKDIR /app/stepcut

COPY stepcut/package.json stepcut/package-lock.json ./
RUN npm ci

COPY stepcut/ ./

# `npm run build` is `tsc --noEmit && vite build` — the typecheck is part of
# the build on purpose, so an image can never be produced from source that CI
# would reject.
RUN npm run build

FROM caddy:2-alpine

COPY --from=build /app/stepcut/dist /srv
COPY stepcut/Caddyfile /etc/caddy/Caddyfile
