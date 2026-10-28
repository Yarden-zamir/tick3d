# KitSHn Recipe

[![deployed with kitshn](https://raw.githubusercontent.com/Yarden-zamir/kitshn/main/assets/badge-deployed-with-kitshn.svg)](https://github.com/Yarden-zamir/kitshn)

This repository deploys with kitshn 2 (https://kit.yarden-zamir.com). GitHub Actions sends the source to kitshn. The kitshn daemon on the VPS builds and starts `compose.yml` in rootless Docker, and a Cloudflare tunnel sends each address to the socket of the app.

## Contract

- `kitshn.config.ts` maps GitHub events to deployment environments. kitshn reads it without running it.
- `.github/workflows/kitshn.yml` calls `kitshn2-deploy.yml` of the kitshn repository. It needs `id-token: write`, because kitshn checks the GitHub OIDC token of the run.
- `compose.yml` defines the services. `site` binds `${KITSHN_DEFAULT_SOCKET}`, and the tunnel sends the address there.
- GitHub variables and secrets that start with `KITSHN_` become params without the prefix. A push reads the GitHub Environment `prod`, and a pull request reads `pr-<number>`. kitshn never passes `KITSHN_SSH_KEY`, `KITSHN_VPS_HOST` or `KITSHN_SSH_KNOWN_HOSTS` to the app.

## Operating This Deployment

- Production and previews run in the rootless Docker of the kitshn daemon user: `DOCKER_HOST=unix:///run/user/1000/docker.sock`. Each environment is a Compose project with the name `app-…` of its kitshn card. Find it with `docker ps`.
- The KitSHn 1 commands (`kitshn diagnose`, `kitshn status`, `kitshn params`) do not know these apps.
- Services publish no host ports. Reach them through the public address, or with `docker compose -p <project> exec`.
- The KitSHn 1 project `yarden-zamir-tick3d-prod` on system Docker is stopped. Its data stays in `/persistent/Yarden-zamir/tick3d/prod` and in its `sessions` volume, for a rollback. That copy stops at the takeover (2026-10-28 10:56 UTC). A rollback to it loses every game played on kitshn 2 since then. Before a rollback, copy the kitshn 2 `sessions` volume aside, so those games stay recoverable.

## This Recipe

- Services: `site` (Caddy that serves `dist/` on the KitSHn socket) and `api` (Node, serves `/api/*`). `api` keeps DuckDB at `/data/tick3d.duckdb` on the `sessions` volume. Each environment has its own volume.
- Environments: `prod` from a push to `main`, and an ephemeral `pr-<number>` for each pull request. A pull request with the label `no-preview` gets no preview.
- Preview limits: none. kitshn 2 has no CPU or memory limit for previews, so a preview competes with production. Revisit when kitshn 2 adds preview limits.
- Hostnames: `tick3d.yarden-zamir.com` for prod, `tick3d-pr-<number>.yarden-zamir.com` for previews. Both are public.
- Variables: `KITSHN_GITHUB_CLIENT_ID`. Secrets: `KITSHN_GITHUB_CLIENT_SECRET`, `KITSHN_AUTH_SECRET`. Without all three, login is off. With only some, `api` stops at start.
- Google login needs the variable `KITSHN_GOOGLE_CLIENT_ID` and the secret `KITSHN_GOOGLE_CLIENT_SECRET`, from a Google Cloud OAuth client of the type "Web application". Its authorized JavaScript origin is `https://tick3d.yarden-zamir.com`, and its redirect URI is `https://tick3d.yarden-zamir.com/api/auth/google/callback`. Without both, the page offers only GitHub. With one of them, `api` stops at start. Google login needs the GitHub login settings too. The Android app needs no Android client, because it is the site in Chrome.
- Android purchase checks need `KITSHN_PLAY_SERVICE_ACCOUNT_JSON` in the `prod` environment. Set it from the service account JSON used by `PLAY_SERVICE_ACCOUNT_JSON`: `gh secret set KITSHN_PLAY_SERVICE_ACCOUNT_JSON --env prod --repo Yarden-zamir/tick3d < service-account.json`. KitSHn strips the prefix and Compose passes it to the API. Do not pass the upload signing key to the server. In Play Console, open tick3d → App integrity → Play Integrity API → Link a Cloud project. In that Cloud project, enable the Google Play Integrity API. The service account must belong to the linked project. Leave response encryption managed by Google. Without credentials, proof submission fails closed; the rest of the game stays available.
- Apple purchase checks need the repository variables `KITSHN_APPLE_BUNDLE_ID` (the same value as `IOS_BUNDLE_ID`) and `KITSHN_APPLE_APP_ID` (App Store Connect → Apps → tick3d → App Information → Apple ID). No Apple private key is needed to verify a signed app transaction. The server uses Apple's public root and the App Store Server Library with online certificate checks. It accepts Production and signed Sandbox transactions while TestFlight stays invite only. Revisit this when the TestFlight link becomes public.
- Secret `KITSHN_TESTER_CODES`, in the GitHub Environment `prod` only, so previews never get it: the Google Play promo codes of `/share`, one entry per line or comma. Set it with `gh secret set KITSHN_TESTER_CODES --env prod --repo Yarden-zamir/tick3d < file`. An entry is `CODE` (free) or `CODE=Name` (given out already, to Name). A bad entry stops `api` at start. Only prod reads it. At start, `api` adds the codes that it does not hold yet, and a known code keeps its row.
- `testing.tick3d.yarden-zamir.com` redirects to `/share` with its query. The KitSHn 1 host Caddy still serves this redirect. Before that Caddy stops, make it a Cloudflare redirect rule (outside this repository). `/testing` redirects to `/share` on every environment (`container/Caddyfile`). Both keep the links from before the rename working.
- Previews have no login: the account cookie is for `tick3d.yarden-zamir.com` and its subdomains, and a preview address is not one of them. Only prod calls GitHub for the preview list.
- A deploy stops the app for a short time. kitshn builds first, then stops the containers, starts the new ones and waits for the socket. In that time, the address shows the kitshn offline page (503), about 30 s on 2026-10-28. While only `api` restarts, `container/Caddyfile` holds the `/api/*` requests. `api` answers the requests that run before it stops (server/main.ts).
- DuckDB allows one process. Stop `api` before you query the database by hand, then start it again.

## Badge

The badge above shows that this repo deploys with KitSHn. For the state of the latest `prod`
deploy in the README, use this line.

```markdown
[![kitshn prod](https://img.shields.io/github/deployments/Yarden-zamir/tick3d/prod?label=kitshn%20%C2%B7%20prod&labelColor=2F3532&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNCAxNCI+PGcgZmlsbD0iI2ZmZiI+PHJlY3QgeD0iNiIgeT0iMS4yIiB3aWR0aD0iMiIgaGVpZ2h0PSIxLjYiIHJ4PSIwLjUiLz48cmVjdCB4PSIyLjIiIHk9IjMuNCIgd2lkdGg9IjkuNiIgaGVpZ2h0PSIxLjUiIHJ4PSIwLjc1Ii8+PHJlY3QgeD0iMyIgeT0iNS42IiB3aWR0aD0iOCIgaGVpZ2h0PSI2LjYiIHJ4PSIxLjYiLz48cmVjdCB4PSIwLjgiIHk9IjYuOCIgd2lkdGg9IjIuNCIgaGVpZ2h0PSIxLjQiIHJ4PSIwLjciLz48cmVjdCB4PSIxMC44IiB5PSI2LjgiIHdpZHRoPSIyLjQiIGhlaWdodD0iMS40IiByeD0iMC43Ii8+PC9nPjwvc3ZnPgo=)](https://tick3d.yarden-zamir.com)
```

## Origin

- Generated from: https://github.com/Yarden-zamir/kitshn/blob/d266328205603dfddffc27c7ac5d42051883d0b0/src/kitshn/repo_init.py
- KitSHn commit: `d266328205603dfddffc27c7ac5d42051883d0b0`
