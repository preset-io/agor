# Self-contained dev image for the Agor docs site (Next.js + Nextra).
#
# Why standalone (no monorepo context): apps/agor-docs has zero workspace
# dependencies, so the image only needs this directory. Avoids dragging the
# whole repo into Docker context.

FROM node:20-alpine

RUN corepack enable

WORKDIR /app

# Install deps first for layer caching. We don't have a per-app lockfile
# (the workspace lock lives at repo root), so we accept --no-frozen-lockfile
# for this dev-only image.
COPY package.json ./
RUN pnpm install --no-frozen-lockfile

# Source is normally bind-mounted via docker-compose for hot reload; this COPY
# is a fallback so the image is usable standalone (e.g. `docker run`).
COPY . .

EXPOSE 3001

CMD ["pnpm", "exec", "next", "dev", "-H", "0.0.0.0", "-p", "3001"]
