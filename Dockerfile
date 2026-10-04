FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json index.html ./
COPY src src
# A failing test or type error stops the image build, so a broken game never deploys.
RUN npm test && npm run build

FROM caddy:2.11-alpine
COPY container/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
