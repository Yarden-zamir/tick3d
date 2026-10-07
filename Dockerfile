FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Every root *.html file is a page (src/pages.ts).
COPY tsconfig.json *.html vite.config.ts ./
# Vite copies public/ (the favicons and icons) into dist as is. The PWA plugin writes the manifest.
COPY public public
COPY src src
COPY server server
# Only the page build. The type check, the linters and the tests run in the check job of the workflow
# (.github/workflows/kitshn.yml), which must pass before a deploy starts.
RUN npx vite build

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
RUN find src server -name '*.test.ts' -delete
# A new named volume copies this owner, so the node user can write the database.
RUN mkdir /data && chown node:node /data
USER node
ENV DB_PATH=/data/tick3d.duckdb
CMD ["node", "server/main.ts"]

FROM caddy:2.11-alpine AS site
COPY container/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
