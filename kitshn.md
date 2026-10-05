# KitSHn Recipe

This repository deploys tick3d to `tick3d.yarden-zamir.com` with KitSHn.

- A push to `main` deploys `prod`. A pull request deploys to `pr.<number>.tick3d.yarden-zamir.com`.
- The `Dockerfile` has three stages. The `build` stage runs the linters, the tests and the build. A lint finding or a failed test stops the deploy.
- The `site` service (`caddy:2.11-alpine`) serves `dist/` and listens on the KitSHn Unix socket (`container/Caddyfile`). The host Caddy routes the hostname to that socket (`Caddyfile.j2`).
- The `api` service (`node:24-alpine`) serves `/api/*` for online play. The `site` Caddy proxies `/api/*` to `api:8080`. The API keeps sessions in DuckDB at `/data/tick3d.duckdb` on the `sessions` volume.
- Each environment has its own `sessions` volume, so a pull request preview never touches production sessions.
- GitHub login needs the repository variable `KITSHN_GITHUB_CLIENT_ID` and the secrets `KITSHN_GITHUB_CLIENT_SECRET` and `KITSHN_AUTH_SECRET` (at least 32 random characters). Without all three, login is off. With only some of them, the API stops at start, so a half setup never goes unnoticed.
- The GitHub App [`tick3d-game`](https://github.com/apps/tick3d-game) handles the login. It is public and asks for no permissions. Its callback is `https://tick3d.yarden-zamir.com/api/auth/github/callback`. Previews send a login to production and read its cookie, which is valid for every subdomain.
- Files in `/assets/` have a content hash in the name, so Caddy caches them for one year. `index.html` and `stats.html` are not cached. Caddy serves `stats.html` at `/stats` with an `X-Robots-Tag: noindex` header.
- The login values are repository-wide, so previews get them too. Only people who can open pull requests from this repository get them.

## Files

- `.kitshn.yaml`, `.github/workflows/kitshn.yml`, `compose.yml`, `Caddyfile.j2`, `Dockerfile`, `container/Caddyfile`: the recipe.

## Operating This Deployment

Run these on the VPS. They take `--environment <env>` and default to `prod`.

- `kitshn diagnose Yarden-zamir/tick3d`: checks Compose, sockets, Caddy routing and config.
- `kitshn status Yarden-zamir/tick3d`: ref, services, health, route, socket, and last deploy, as JSON.
- `kitshn logs Yarden-zamir/tick3d site`: Docker logs for the site container.
- `kitshn logs Yarden-zamir/tick3d api`: Docker logs for the API container.
- To query the database by hand, stop the `api` service first. While the API runs, DuckDB lets no other process open the file. Then run `kitshn compose Yarden-zamir/tick3d -- run --rm api node --input-type=module -e "<script>"` with `@duckdb/node-api`, and start `api` again.

## Origin

- Generated from: https://github.com/Yarden-zamir/kitshn/blob/53fedf8e2c02905c3b83e8ebd2b3b3c453d0ce85/src/kitshn/repo_init.py
- KitSHn commit: `53fedf8e2c02905c3b83e8ebd2b3b3c453d0ce85`
