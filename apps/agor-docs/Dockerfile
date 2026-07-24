# Self-contained dev image for the Agor docs site (Next.js + Nextra).
#
# Why standalone (no monorepo context): apps/agor-docs has zero workspace
# dependencies, so the image only needs this directory. Avoids dragging the
# whole repo into Docker context.

FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@11.13.0 --activate

WORKDIR /app

# Install deps first for layer caching. We don't have a per-app lockfile
# (the workspace lock lives at repo root), so we accept --no-frozen-lockfile
# for this dev-only image.
COPY package.json ./
# Two lockfile-less install fixups, image-side only (the monorepo root owns
# the real workspace file):
# - nextra 4.6.1 breaks against zod 4.4.x ("expected nonoptional" 500s on
#   every page); the root lockfile pins 4.1.12, so mirror that here.
# - pnpm 11 hard-fails on unapproved dependency build scripts (esbuild,
#   sharp), and 11.13 ignores the onlyBuiltDependencies allowlist in this
#   standalone layout — approve all builds for this dev-only image.
RUN printf 'overrides:\n  "zod@^4": 4.1.12\n' > pnpm-workspace.yaml \
  && pnpm install --no-frozen-lockfile --config.dangerouslyAllowAllBuilds=true

# Source is normally bind-mounted via docker-compose for hot reload; this COPY
# is a fallback so the image is usable standalone (e.g. `docker run`).
COPY . .

EXPOSE 3001

CMD ["node_modules/.bin/next", "dev", "-H", "0.0.0.0", "-p", "3001"]
