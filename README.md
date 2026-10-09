# tick3d

[![kitshn](https://kitshn.yarden-zamir.com/b/Yarden-zamir/tick3d.svg)](https://tick3d.yarden-zamir.com)

3D tic-tac-toe on a 4×4×4 cube, at [tick3d.yarden-zamir.com](https://tick3d.yarden-zamir.com).

![A game against the computer in the tower view](docs/screenshots/tower.png)

## Rules

- Two players take turns. X moves first.
- Four marks in a straight line win. The cube has 76 lines.
- In an online or Nearby session, X and O swap for each new game, so the first move alternates. Against the computer you start every game unless you unlock the seats.
- A full cube with no line is a draw.

## Features

- Play against the computer, a friend on the same device, a friend online, or a device on the same Wi-Fi (Nearby).
- Three computer levels: easy, medium and hard. "Advanced: computer player" in the panel tunes each level.
- Two views: a 3D tower that you turn with a drag, and a flat view with four layouts.
- Play by coordinates on the keypad, with the board or the marks hidden.
- Time limits per game, per move, or both. A player who runs out loses.
- Lock: no setting changes until the game ends.
- Seat lock: keeps X and O between games. It sits next to "You play" (computer) and in the Players box (online, Nearby). Either player can change it.
- Sound sets where each cell has its own sound, and an ear trainer at `/sound-training`.
- One sound rule on every page: a press on a button, switch or menu item clicks at once. A control with its own sound (a move, a refusal, a sample, a song) plays only that sound. Disabled controls stay quiet, and the mute holds.
- Play by voice: tap the mic, then hold a note on a free cell for 1 second to place your move. On a phone, turn on Tilt in the Voice room settings (off by default): a small tilt nudges the cell up to 3 cells.
- The Voice room at `/sound-input`: calibrate the mic to your voice, then practice with Free play, Targets, Echo, or a Playoff against the other player of an online game. The page finds the pitch on the device and sends no sound.
- Your game as a song: the Song button on the end card and on a game link. A long press shares the song as a WAV file, with your voice on the moves that your voice placed.
- An end card with the result, to share or save as an image.
- Survival records: the longest game against each computer level and setup.
- Twelve themes.
- The same header on every page, with My games, Info, kitshn and GitHub (`src/header/`).
- The kitshn button lists the production site and the open pull request previews. A stacked pull request shows inside its parent.
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
- After each new game, the seats swap unless a player locked them. The score and My games count each game for the player who played it.
- Chat, the hide options, the lock and the time limit belong to the session, so both players share them.
- The server decides a timeout, so a page that closes cannot avoid a loss on time.
- A session with moves never expires. A player can leave and come back, so a game can run asynchronously.

### Report and block

- Hold, right-click, or press the context-menu key (Shift+F10) on a chat message, a player or a watcher. A small menu offers Report and Block.
- Block hides the person's messages, and shows a generated name and picture in place of theirs. The server keeps the list per player, so it follows a GitHub login. Unblock in My games.
- Report sends a reason and a short note to the maintainers, and hides that message on your device. Report works in Online games only: the server cannot see a Nearby game.
- Each person has a public person id, a hash of the player token. A chat message keeps the person id of its author, so it stays with the author when the seats change. Older messages have none: they show with the player on their seat.
- The maintainers (GitHub logins Yarden-zamir and TomCohenDev) read the reports with `GET /api/reports`. They can hide a message for everyone or clear a custom name, and the server logs each action.

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
| Seat lock (keep X and O between games) | next to You play | no | in the Players box | in the Players box | no |
| Game code, Link, QR code, session name | no | no | yes (grey until a game starts) | no | no |
| Host, Join with a code, Games near you, device list | no | no | no | yes | no |
| Join a friend (code and New code) | no | no | yes | no | no |
| Players (seats, watchers and seat controls) | no | no | yes (grey until a game starts) | yes (grey until a game starts) | no |
| Time limit | yes | yes | yes | yes | no |
| Hide board, history and coordinates, Lock | yes | yes | yes (off until a game starts) | yes (off until a game starts) | no |
| Score, New game, the session games in My games | yes | yes | yes (grey until a game starts) | yes (grey until a game starts) | yes (no session games) |
| Undo (during a game) | yes | yes | for a player in a game (asks the other player) | for a player in a game (asks the other player) | no |
| Result card (after a game) | yes | yes | in a game | in a game | no |
| Chat | no (a wide screen keeps its space) | no | yes | yes | no |
| Report and block (hold or right-click a person) | no | no | yes | Block only | no |
| Play by voice | yes | yes | with a seat | with a seat | no |

"In a game" and "a game starts" mean after a create or a join (Online), or after Host or Join (Nearby).

Before a game starts, a control of a game (`data-needs-session`) draws at once in its final place, grey and disabled (`data-pending` in `src/style.css`). The Players box shows two "Waiting…" seats with grey pictures, and the clocks of a time limit keep their place. When the server or the Nearby host answers, the page fills in the real values, and nothing moves. If the server fails, the error shows and the controls stay grey in their place.

The actions row has fixed slots (`.slot-row` in `src/style.css`), so a control that shows or hides never moves another control. `e2e/row-layout.spec.ts` checks this.

A mode change moves neither the board nor the Opponent picker:

- Everything above the picker keeps its box in every mode. Before a game, the score and New game show grey and disabled in their place. The Players box sits under the mode boxes.
- A wide screen (72rem and wider) keeps the chat column in every mode. Outside a game with another device, that column stays empty.
- On a phone the chat opens above the panel. If the player works in the panel, the page scrolls by the height of the chat, so the panel stays still (`src/page/panel-anchor.ts`).

## Accounts and My games

- Login with GitHub is optional. Without a login, every browser plays with a random token and a generated name, such as "braveOtter".
- A login lets a player continue a game on every device of the account.
- A player without a login can choose a name in My games.
- My games shows the account, the stats, the games of the open session, the match history and the online sessions. Stats in its head opens your own stats.

<img src="docs/screenshots/my-games.png" alt="My games: stats and sessions" width="480">

## Code

- `src/game.ts`: board, lines, move validation, win and draw.
- `src/ai.ts`, `src/ai-worker.ts`, `src/move-search.ts`: the computer levels, in a Web Worker.
- `src/session/core.ts`: the session rules. The server, the device and the Nearby host all run them.
- `src/session/format.ts`: the stored session format.
- `src/protocol.ts`: the contract between the page and the API.
- `src/online.ts`: the API client. `src/local.ts` and `src/device-db.ts`: the device backend on IndexedDB.
- `src/nearby/`: WebRTC, QR codes and the host and guest sessions.
- `src/sound.ts`, `src/sound-sets.ts`: the sounds and the sound sets. `src/click-sound.ts`: the click of every control. `src/song.ts`: a finished game as a song.
- `src/voice/`: the voice engine (pitch, range, sticky cells, tilt, clips) for the game and the Voice room. `src/page/voice.ts`: play by voice in the game.
- `sound-input.html`, `src/sound-input/`: the Voice room. `src/practice/`: the practice and playoff rules, shared with `server/practice.ts`.
- `src/main.ts`, `src/page/`, `index.html`, `src/style.css`: the game page, one module per feature in `src/page/`.
- `src/page/safety.ts`, `src/page/person-mark.ts`: the report and block menu.
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

Both come from `server/api-docs.ts`. The routes that change a game accept an `Idempotency-Key` header, and every 429 has a `Retry-After` header.

## Stats page and what is logged

- `/stats` is public: the game Info panel and My games link to it, and search engines may list it.
- Filters: Everyone or Mine, the time (7 days, 30 days or all), the mode and the level. The address holds them, for example `/stats?scope=mine&range=30d`. `GET /api/stats` takes the same query and answers 400 for an unknown value.
- A person filter (`/stats?person=<person id>`) shows the games of one person, with their name and picture. A click on a person's picture in the game opens it large, with a Stats link to this view.
- "Hide my stats" in My games closes your person view to everyone but you: `GET /api/stats` then answers 403. Mine still works, and Everyone still counts your games without your name. The setting follows a GitHub login.
- Everyone shows counts only: no player names and no page faults. Mine (your games on every linked device) adds your win rate over time, streaks, results, survival records and favourite opponents. A person view adds the same, without the opponents.
- The stats never show a token, a result id or a game id.
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
docker run --rm --ipc=host -v "$PWD":/app -w /app -e E2E_BASE_URL=https://pr-17.tick3d.yarden-zamir.com mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'npm ci && npm run e2e'
```

- Keep the image tag equal to the `@playwright/test` version in `package.json`.
- After a run in the Playwright image, run `npm ci` again before you use `node:26-alpine`.
- The `e2e` workflow runs the suite after each successful pull request preview deploy. It starts when the preview answers its health check 3 times in a row.

## Video

`video/` holds a 15 s spot made in code: three.js draws every frame, Remotion renders it, and the sound comes from the game's own sound code. The creative (brief, script, timeline and build prompts) is in [video/creative/](video/creative/).

```sh
docker run --rm -v "$PWD":/app -w /app/video node:26 sh -c 'npm ci && npm run check && npm run video'
```

- `npm run video` writes `video/out/tick3d-15s-landscape.mp4` (1920×1080), `video/out/tick3d-15s-portrait.mp4` (1080×1920), one still per bar in `video/out/stills/` and the soundtrack in `video/out/soundtrack.wav`.
- The render needs the system libraries of Chrome Headless Shell, so use `node:26`, not the Alpine image.
- `VIDEO_VARIANT=<name> npm run video` renders a variant of the spot into `video/out/variants/<name>/`. A variant is a small overlay on `beats.json` in `video/creative/variants/<name>.json` that changes the themes, the sound sets and the camera of bars, and the on-screen text, never the game or the events. The takes: `classic` (the base cut), `hook` (a Mono cold open, "Tic-tac-toe? / Too easy."), `features` (the 13 best features as cards), `arcade` (neon and Chiptune, with feature cards in bar 4) and `mellow` (soft themes and mallets).
- The `video` workflow renders every variant in both crops, one job each, on a manual run, on a push to `main` that touches `video/`, and on a pull request that touches it. It uploads one `tick3d-video-<variant>-<crop>` artifact per job. On a pull request from this repository it also publishes a GIF, the stills sheets and the MP4s of each variant to the `pr-assets` branch, in `issue-119/renders/<7 characters of the head sha>/<variant>/`. Each run gets its own folder, so a comment that links a render keeps showing it. A tag `video-v*` also attaches the classic files to a GitHub Release.

**Fast iteration.** On macOS, the render uses WebGL on the GPU, one browser tab per core for the MP4, and one tab per still. On an M1 Max (10 cores), the draft stills of all 8 bars in both crops take 6 s. A full variant (`VIDEO_VARIANT=mellow npm run video`: both MP4s and all stills) takes 25 s. The first render also downloads Chrome Headless Shell. On a Linux host without a GPU, WebGL runs on the CPU, and a full variant takes about 20 minutes. There, do not render MP4s. Check an edit with half-size draft stills of the bars that changed, then push. CI renders one job per variant and crop in parallel in about 3 minutes, then publishes the previews:

```sh
docker run --rm -v "$PWD":/app -w /app/video node:26 node scripts/render.ts --draft --bars 2,5
```

`video/scripts/previews.sh <out-dir> <dest-dir>` makes the same previews as CI (the stills sheets, the GIF and the MP4s) from a local render, with ImageMagick and ffmpeg on PATH. The drafts land in `video/out/draft/` (or `video/out/variants/<name>/draft/` with `VIDEO_VARIANT`). Locally, run only `npm run check` in `video/` and `node video/creative/tools/check-beats.ts`; the required `check` workflow runs the full gate on every push.

## Deploy

See [kitshn.md](kitshn.md). A push to `main` deploys production.

The paid Android app on Google Play wraps the production site. The `android` workflow builds it from [android/twa-manifest.json](android/twa-manifest.json), and the `play-*` workflows release it, sync the listing and file issues from reviews and crashes.

## License

[MIT](LICENSE)
