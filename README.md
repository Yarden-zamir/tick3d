# tick3d

[![kitshn](https://kitshn.yarden-zamir.com/b/Yarden-zamir/tick3d.svg)](https://tick3d.yarden-zamir.com)

3D tic-tac-toe on a 4×4×4 cube, at [tick3d.yarden-zamir.com](https://tick3d.yarden-zamir.com).

![A game against the computer in the tower view](docs/screenshots/tower.png)

## Rules

- Two players take turns. X moves first.
- Four marks in a straight line win. The cube has 76 lines.
- A full cube with no line is a draw.

## Features

- Play against the computer, a friend on the same device, a friend online, or a device on the same Wi-Fi (Nearby).
- Three computer levels: easy, medium and hard. "Advanced: computer player" in the panel tunes each level.
- Two views: a 3D tower that you turn with a drag, and a flat view with four layouts.
- Play by coordinates on the keypad, with the board or the marks hidden.
- Time limits per game, per move, or both. A player who runs out loses.
- Lock: no setting changes until the game ends.
- Sound sets where each cell has its own sound, and an ear trainer at `/sound-training`.
- An end card with the result, to share or save as an image.
- Survival records: the longest game against each computer level and setup.
- Twelve themes.
- The same header on every page, with My games, Info, kitshn and GitHub (`src/header/`).
- The browser keeps the settings in `localStorage`, and the page checks each stored value.

![The flat view in the grid layout, Midnight theme](docs/screenshots/flat.png)

![Synthwave, Candy and Mono themes on a phone](docs/screenshots/themes.png)

<img src="docs/screenshots/end-card.png" alt="The end card of a won game" width="360">

## Game links and match history

- Every finished game gets a read-only link, for example `/?game=AB3K-2` (online) or `/?game=K7P2QX9M` (other modes).
- My games lists every finished game, newest first, and can clear the history.

## Online play

- Choose Online to create a session with a 4 character code (`?code=AB3K`). Share the link or the QR code.
- The creator plays X, the first other browser plays O, and further browsers watch.
- Either player controls the seats. A change to the other player's seat, and an undo, waits until that player accepts.
- Chat, the hide options, the lock and the time limit belong to the session, so both players share them.
- The server decides a timeout, so a page that closes cannot avoid a loss on time.
- A session with moves never expires. A player can leave and come back, so a game can run asynchronously.

![An online game with chat, while the other player is away](docs/screenshots/online.png)

## Play with an AI agent

- An AI agent plays through the HTTP API, with no account and no key.
- In computer mode, open "Advanced: computer player" and copy the text under "Play with your AI agent". Give it to your agent.
- The text points the agent to `/api/openapi.json`. The agent can play you or another agent.

## Offline play

- After the first visit, a service worker keeps the page, so the game opens without a network. The game is installable.
- Computer, friend and Nearby games run on the device and stay in IndexedDB. The device uploads results when it has a network.
- After a deploy, the page shows "A new version of tick3d is ready" with a Reload button.
- Safari deletes the data of a site that you do not open for 7 days, unless you add the game to the home screen.

## Nearby

- Choose Nearby to play with devices on the same Wi-Fi. One device hosts, the others join.
- Online, the hosted game shows in "Games near you" on the other devices of the same network.
- Offline, the devices exchange QR codes, or text codes to copy and paste.
- The devices talk directly over WebRTC. The host's device holds the session and checks every move with the same rules as the server.
- To host a full server on a laptop, run `docker compose -f compose.lan.yml up --build`. Others open `http://<that computer's address>:8080` and play Online. Set `LAN_HOST_NAME` for the host name and `LAN_PORT` for another port.

![A laptop hosts a Nearby game, a phone joins](docs/screenshots/nearby.png)

## Controls per mode

The panel shows a control only in the modes where it applies (`data-show-mode` and `data-needs-session` in `index.html`). A finished game from a link shows only the controls for looking at it.

| Control | Computer | Friend | Online | Nearby | Game from a link |
| --- | --- | --- | --- | --- | --- |
| Opponent, view, layout, theme, sound | yes | yes | yes | yes | yes |
| Difficulty, You play, Advanced | yes | no | no | no | no |
| Game code, Link, QR code, session name | no | no | yes | no | no |
| Host, Join with a code, Games near you, device list | no | no | no | yes | no |
| Join a friend (code and New code) | no | no | yes | no | no |
| Players (seats, watchers and seat controls) | no | no | in a game | in a game | no |
| Time limit | yes | yes | yes | yes | no |
| Hide board, history and coordinates, Lock | yes | yes | in a game | in a game | no |
| Score, New game, the session games in My games | yes | yes | in a game | in a game | yes (no session games) |
| Undo (during a game) | yes | yes | for a player in a game (asks the other player) | for a player in a game (asks the other player) | no |
| Result card (after a game) | yes | yes | in a game | in a game | no |
| Chat | no | no | yes | yes | no |

"In a game" means after a create or a join (Online), or after Host or Join (Nearby).

The actions row has fixed slots (`.slot-row` in `src/style.css`), so a control that shows or hides never moves another control. `e2e/row-layout.spec.ts` checks this.

## Accounts and My games

- Login with GitHub is optional. Without a login, every browser plays with a random token and a generated name, such as "braveOtter".
- A login lets a player continue a game on every device of the account.
- A player without a login can choose a name in My games.
- My games shows the account, the stats, the games of the open session, the match history and the online sessions.

<img src="docs/screenshots/my-games.png" alt="My games: stats and sessions" width="480">

## Code

- `src/game.ts`: board, lines, move validation, win and draw.
- `src/ai.ts`, `src/ai-worker.ts`, `src/move-search.ts`: the computer levels, in a Web Worker.
- `src/session/core.ts`: the session rules. The server, the device and the Nearby host all run them.
- `src/session/format.ts`: the stored session format.
- `src/protocol.ts`: the contract between the page and the API.
- `src/online.ts`: the API client. `src/local.ts` and `src/device-db.ts`: the device backend on IndexedDB.
- `src/nearby/`: WebRTC, QR codes and the host and guest sessions.
- `src/sound.ts`, `src/sound-sets.ts`: the sounds and the sound sets.
- `src/main.ts`, `src/page/`, `index.html`, `src/style.css`: the game page, one module per feature in `src/page/`.
- `src/header/`: the header of every page. `src/markup.test.ts` checks that every page has the same header.
- `stats.html`, `src/stats/`: the stats page. `sound-training.html`, `src/sound-training/`: the ear trainer.
- `src/pwa.ts`, `vite.config.ts`: the service worker and the manifest.
- `server/main.ts`: the HTTP API. `server/store.ts`: the DuckDB store. `server/auth.ts`: GitHub login.
- `server/api-docs.ts`: every API route with its docs. The server finds routes in this list.

To add a route, add one entry to `ROUTES` in `server/api-docs.ts` and one case to the switch in `server/main.ts`. The type check fails when one of the two is missing.

The page is plain TypeScript built with Vite, with no runtime dependencies. The API runs TypeScript directly on Node 26 and stores data in [DuckDB](https://duckdb.org).

## Stored data and format changes

- The server and the device store a session as the same document, with a `format` number.
- A new optional field needs only a default in `parseDoc` (`src/session/format.ts`). It needs no migration and no database reset.
- A breaking change needs a new `CURRENT_FORMAT` and one `UPGRADES` step. `src/session/format.ts` explains the rules.
- `src/session/fixtures/` holds a document of each released format. A test reads each one.
- Table changes are append-only statements in `server/store.ts`, such as `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

## API

- `/api/openapi.json`: the OpenAPI 3.1 document, with every route, shape, error and a curl example.
- `/api/docs`: the same document in Swagger UI.

Both come from `server/api-docs.ts`.

## Stats page and what is logged

- `/stats` shows aggregate counts of all games. Nothing links to it, and search engines do not list it.
- The stats show counts and player names only. They never show a token, a result id or a game id.
- A finished game sends, besides the game: the device kind, the view, the layout, the theme, input and undo counts, refusals, computer thinking times, the offline flag and the app version.
- A fault report holds the error message, the file and line, and the app version. It holds no token and no address.

## Develop

Node is not necessary on the host. Run the commands in a container:

```sh
docker run --rm -v "$PWD":/app -w /app node:26-alpine sh -c 'npm ci && npm run check && npm run build'
docker run --rm -it -p 5173:5173 -v "$PWD":/app -w /app node:26-alpine npx vite --host
```

- `npm run check` runs the type check, the linters (`npm run lint`) and the unit tests.
- `npm run build` runs the type check and the Vite build.
- `npm run api` starts the API on port 8080 with `./dev.duckdb`.

`npm run e2e` runs the Playwright tests in `e2e/` against a deployed site. Set `E2E_BASE_URL` to the site, for example a pull request preview:

```sh
docker run --rm --ipc=host -v "$PWD":/app -w /app -e E2E_BASE_URL=https://pr.17.tick3d.yarden-zamir.com mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'npm ci && npm run e2e'
```

- Keep the image tag equal to the `@playwright/test` version in `package.json`.
- After a run in the Playwright image, run `npm ci` again before you use `node:26-alpine`.
- The `e2e` workflow runs the suite after each successful pull request preview deploy.

## Deploy

See [kitshn.md](kitshn.md). A push to `main` deploys production.

## License

[MIT](LICENSE)
