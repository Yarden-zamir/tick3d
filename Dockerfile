FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Every root *.html file is a page (src/pages.ts).
COPY tsconfig.json *.html vite.config.ts ./
# Vite copies public/ (the favicons and icons) into dist as is. The PWA plugin writes the manifest.
COPY public public
# The build reads the package id and the key fingerprints of the Android app for /.well-known/assetlinks.json.
COPY android/twa-manifest.json android/
COPY src src
COPY server server
# The release name comes from the commit (vite.config.ts, src/release.ts). compose.yml passes the
# checkout's .git as the `git` context and the environment, which adds "(pr-<n>)" to a preview name.
RUN apk add --no-cache git
ARG KITSHN_ENVIRONMENT
# Only the page build. The type check, the linters and the tests run in the check job of the workflow
# (.github/workflows/kitshn.yml), which must pass before a deploy starts.
RUN --mount=type=bind,from=git,target=/app/.git npx vite build

# The API runs its TypeScript directly: Node 26 strips the types. DuckDB is its only runtime package.
FROM node:26-alpine AS api
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime packages only: the DuckDB client and its native binding for Alpine (musl).
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Copy whole folders: a list of single files missed a new shared module once (src/clock.ts).
# Page-only modules come along but Node never loads them. Tests do not belong in a runtime image.
COPY --from=build /app/src src/
COPY --from=build /app/server server/
COPY --from=build /app/android/twa-manifest.json android/twa-manifest.json
# The release of this build: the API stores it at start (server/main.ts).
COPY --from=build /app/dist/release.json release.json
RUN find src server -name '*.test.ts' -delete
# A new named volume copies this owner, so the node user can write the database.
RUN mkdir /data && chown node:node /data
USER node
ENV DB_PATH=/data/tick3d.duckdb
CMD ["node", "server/main.ts"]

# The Rust API (rust/server, issue #265). compose.yml runs rust-api as the `api` service. The Node `api` stage above
# stays for compose.lan.yml until LAN hosts switch too. Build by hand: docker build --target rust-api --build-context git=.git .
# The duckdb crate downloads libduckdb.so for glibc at build time, so these stages use Debian, not Alpine.
FROM rust:1.99.1-slim-trixie AS rust-build
WORKDIR /src
COPY rust rust
# The Apple root certificate goes into the binary (rust/server/src/apple_proof.rs).
COPY server/apple-roots server/apple-roots
# The cache mounts keep the crates and the build between deploys, so a deploy compiles only what changed. A cold build
# takes about 9 minutes on the VPS; without the caches every deploy would pay that.
# The cache is shared by every build on the builder, so it can hold several libduckdb.so. Cargo names the out_dir of the
# build script that this binary used (also for a cached build), and the stage copies that one, or stops.
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/rust/target \
  cd rust && cargo build --release --locked -p tick3d-server --message-format=json-render-diagnostics > /tmp/build.json \
  && duckdb_out=$(grep '"reason":"build-script-executed"' /tmp/build.json | grep '"package_id":"[^"]*libduckdb-sys@' | sed -E 's/.*"out_dir":"([^"]+)".*/\1/') \
  && test -f "$duckdb_out/libduckdb.so" \
  && mkdir /out && cp target/release/tick3d-server "$duckdb_out/libduckdb.so" /out/

FROM debian:trixie-slim AS rust-api
# The logins and purchase checks call GitHub, Google and Apple over TLS. The compose health check runs wget.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/*
COPY --from=rust-build /out/libduckdb.so /usr/local/lib/
RUN ldconfig
COPY --from=rust-build /out/tick3d-server /usr/local/bin/
WORKDIR /app
# The release of this build: the API reads release.json in its working directory at start (rust/server/src/main.rs).
COPY --from=build /app/dist/release.json release.json
RUN useradd --system --uid 1000 tick3d && mkdir /data && chown tick3d:tick3d /data
USER tick3d
ENV DB_PATH=/data/tick3d.duckdb
CMD ["tick3d-server"]

# Toys (container/build-toys.sh), served at /toys/. Only a pull request preview (pr-<n>) builds them: production,
# manual deploys and LAN hosts serve no toys. A toy reads the whole committed tree from .git, because .dockerignore
# keeps out files that it can need, such as *.md.
FROM node:26-alpine AS toys
RUN apk add --no-cache git && git config --global safe.directory '*'
WORKDIR /tick3d
COPY container/build-toys.sh /usr/local/bin/build-toys.sh
ARG KITSHN_ENVIRONMENT
RUN --mount=type=bind,from=git,target=/tick3d/.git \
  case "$KITSHN_ENVIRONMENT" in \
    pr-*) git archive HEAD | tar -x && sh /usr/local/bin/build-toys.sh /toys ;; \
    *) mkdir /toys ;; \
  esac

FROM caddy:2.11-alpine AS site
COPY container/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
COPY --from=toys /toys /srv/toys
