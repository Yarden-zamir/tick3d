# KitSHn Recipe

This repository deploys tick3d to `tick3d.yarden-zamir.com` with KitSHn.

- A push to `main` deploys `prod`. A pull request deploys to `pr-<number>.tick3d.yarden-zamir.com`.
- The `check` job of `.github/workflows/kitshn.yml` runs `npm run check` and `npm run build`. A production or manual deploy waits for it. A pull request preview starts at once, next to the check.
- The `site` service (Caddy, `container/Caddyfile`) serves `dist/` on the KitSHn Unix socket. The host Caddy (`Caddyfile.j2`) routes the hostname to that socket.
- The image build reads the release name from the deployed commit: the pull request title of a merge, else the commit subject. A preview adds `(pr-<number>)`. `compose.yml` passes the checkout's `.git` as a second build context. The `api` service stores the name in the `releases` table at start, and the stats page shows it.
- The `api` service serves `/api/*`. It keeps data in DuckDB at `/data/tick3d.duckdb` on the `sessions` volume. Each environment has its own volume.
- The kitshn button lists the previews of `PREVIEWS_REPO` at `PREVIEWS_DOMAIN`. Both values are in `compose.yml`. A fork changes them.
- Only production (`KITSHN_ENVIRONMENT=prod`) calls GitHub for that list, because all environments share one GitHub rate limit. A preview reads the list from production.
- GitHub login needs the repository variable `KITSHN_GITHUB_CLIENT_ID` and the secrets `KITSHN_GITHUB_CLIENT_SECRET` and `KITSHN_AUTH_SECRET` (at least 32 random characters). Without all three, login is off. With only some of them, the API stops at start.
- The GitHub App [`tick3d-game`](https://github.com/apps/tick3d-game) handles the login. Its callback is `https://tick3d.yarden-zamir.com/api/auth/github/callback`. Previews use the production login.

## Files

- `.kitshn.yaml`, `.github/workflows/kitshn.yml`, `compose.yml`, `Caddyfile.j2`, `Dockerfile`, `container/Caddyfile`: the recipe.

## Operating This Deployment

Run these on the VPS. They take `--environment <env>` and default to `prod`.

- `kitshn diagnose Yarden-zamir/tick3d`: checks Compose, sockets, Caddy routing and config.
- `kitshn status Yarden-zamir/tick3d`: ref, services, health, route, socket and last deploy, as JSON.
- `kitshn logs Yarden-zamir/tick3d site`: the logs of the site container.
- `kitshn logs Yarden-zamir/tick3d api`: the logs of the API container.
- To query the database by hand, stop the `api` service first, because DuckDB lets only one process open the file. Then run `kitshn compose Yarden-zamir/tick3d -- run --rm api node --input-type=module -e "<script>"` with `@duckdb/node-api`, and start `api` again.

## Origin

- Generated from: https://github.com/Yarden-zamir/kitshn/blob/53fedf8e2c02905c3b83e8ebd2b3b3c453d0ce85/src/kitshn/repo_init.py
- KitSHn commit: `53fedf8e2c02905c3b83e8ebd2b3b3c453d0ce85`
