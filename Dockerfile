# The AP Labs runtime as a container (Story 11.2). How to run it, and what the
# host must provide: docs/runtime/container.md.
#
# Base image: node:24-bookworm-slim (Node 24.22.1), the linux/amd64 image,
# pinned by digest. Debian (glibc), not Alpine: DuckDB's prebuilt binaries
# need glibc. amd64 only.
# Digest source: Docker Hub registry, library/node:24-bookworm-slim, read
# 2026-10-25 (image built 2026-10-21; multi-arch index
# sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205,
# whose linux/amd64 entry is the digest below).
FROM --platform=linux/amd64 node:24-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae

# Env only: the image never reads the macOS Keychain. APLABS_PROFILE,
# APLABS_APP_DIR and every secret are set by whoever runs the image, never
# here. APLABS_VAR_DIR and /tmp are the only writable paths.
ENV NODE_ENV=production \
    APLABS_NO_KEYCHAIN=1 \
    APLABS_VAR_DIR=/var/lib/aplabs

WORKDIR /app

# Dependencies for the image's own platform; node_modules never comes from
# the host (.dockerignore keeps it out). The route map's rasterizer
# (@resvg/resvg-js, Story 15.3) needs no install script: npm picks its prebuilt
# @resvg/resvg-js-linux-x64-gnu package from the lockfile for this platform,
# and CI's container job renders the map fixtures inside the image to prove it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The app's files, owned by root: the runtime user can read them, not change them.
COPY . .

# The MotherDuck extension, installed at build (DEP-016) into the runtime
# user's DuckDB folder, owned by root. The app never installs anything.
RUN node scripts/install-duckdb-extensions.js --extension-dir /home/node/.duckdb/extensions

# The one writable folder for the app's own files.
RUN mkdir -p /var/lib/aplabs && chown node:node /var/lib/aplabs

# The runtime user: node (uid 1000, from the base image). DuckDB looks for
# extensions under $HOME/.duckdb, so HOME is set to match.
ENV HOME=/home/node
USER node

# Exec form, so SIGTERM reaches the app's own shutdown.
CMD ["node", "kit/runtime/app"]
