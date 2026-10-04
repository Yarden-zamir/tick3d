FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json index.html ./
COPY src src
COPY server server
# A failing test or type error stops the image build, so a broken game never deploys.
RUN npm test && npm run build

# The API runs its TypeScript directly: Node 24 strips the types. It has no runtime dependencies.
FROM node:24-alpine AS api
WORKDIR /app
COPY package.json ./
# Copy whole folders: a list of single files missed a new shared module once (src/clock.ts).
COPY --from=build /app/src src/
COPY --from=build /app/server server/
# A new named volume copies this owner, so the node user can write the database.
RUN mkdir /data && chown node:node /data
USER node
ENV DB_PATH=/data/tick3d.db
CMD ["node", "server/main.ts"]

FROM caddy:2.11-alpine AS site
COPY container/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
