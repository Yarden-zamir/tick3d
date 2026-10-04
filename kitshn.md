# KitSHn Recipe

This repository deploys tick3d to `tick3d.yarden-zamir.com` with KitSHn.

- A push to `main` deploys `prod`. A pull request deploys to `pr.<number>.tick3d.yarden-zamir.com`.
- The `Dockerfile` has three stages. The `build` stage runs the tests and the build. A failed test stops the deploy.
- The `site` service (`caddy:2.11-alpine`) serves `dist/` and listens on the KitSHn Unix socket (`container/Caddyfile`). The host Caddy routes the hostname to that socket (`Caddyfile.j2`).
- The `api` service (`node:24-alpine`) serves `/api/*` for online play. The `site` Caddy proxies `/api/*` to `api:8080`. The API keeps sessions in SQLite at `/data/tick3d.db` on the `sessions` volume.
- Each environment has its own `sessions` volume, so a pull request preview never touches production sessions.
- Files in `/assets/` have a content hash in the name, so Caddy caches them for one year. `index.html` is not cached.
- There are no secrets beyond `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY`.

## Files

- `.kitshn.yaml`, `.github/workflows/kitshn.yml`, `compose.yml`, `Caddyfile.j2`, `Dockerfile`, `container/Caddyfile`: the recipe.

## Operating This Deployment

Run these on the VPS. They take `--environment <env>` and default to `prod`.

- `kitshn diagnose Yarden-zamir/tick3d`: checks Compose, sockets, Caddy routing and config.
- `kitshn status Yarden-zamir/tick3d`: ref, services, health, route, socket, and last deploy, as JSON.
- `kitshn logs Yarden-zamir/tick3d site`: Docker logs for the site container.
- `kitshn logs Yarden-zamir/tick3d api`: Docker logs for the API container.
- `kitshn compose Yarden-zamir/tick3d -- exec api node -e "<script>"`: run a query against the database with `node:sqlite`. The image has no `sqlite3` binary.

## Origin

- Generated from: https://github.com/Yarden-zamir/kitshn/blob/53fedf8e2c02905c3b83e8ebd2b3b3c453d0ce85/src/kitshn/repo_init.py
- KitSHn commit: `53fedf8e2c02905c3b83e8ebd2b3b3c453d0ce85`
