# tick3d

3D tic-tac-toe on a 4×4×4 cube, at [tick3d.yarden-zamir.com](https://tick3d.yarden-zamir.com).
It replaces the Lovable version at [3tees.yarden-zamir.com](https://3tees.yarden-zamir.com) ([voice-quad-checkers-arena](https://github.com/Yarden-zamir/voice-quad-checkers-arena)).

## Rules

- Two players take turns. X moves first.
- Four marks in a straight line win. There are 76 lines: 48 along an axis, 24 diagonals inside a plane, and 4 through the cube.
- A full cube with no line is a draw.

## Features

- Play against the computer, a friend on the same device, or a friend online.
- The computer has three levels:
  - Easy: takes a win when it sees one, otherwise plays a random cell.
  - Medium: takes a win, blocks your win, otherwise picks one of its three best cells.
  - Hard: takes a win, blocks your win, otherwise searches ahead with alpha-beta pruning for up to 600 ms.
- Move validation: an occupied cell, a move after the game ends, a move out of turn, or a move by a spectator is refused with a sound and a message. The server checks online moves again with the same rules.
- Hide the board, or hide all marks except the last move. Play by coordinates: type the layer, row and column, for example `2 3 4`. Hidden marks show again when the game ends.
- Lock settings: after a lock, no setting (the view included) changes until the game ends. In a local game, a page reload ends the lock. In an online session, either player can lock, the server keeps the lock, and it holds for both players.
- Session history: the panel lists the games of the session. Replay steps through a finished game move by move.
- Sound effects made with Web Audio. Each layer has its own note. A mute button keeps the choice.
- Two views: a 3D tower of tilted layers and a flat view. The flat view has four layouts: grid, side by side, top to bottom, and steps.
- Light and dark themes in a neo-brutalist style. The theme follows the device until you pick one. Like the mute button, it stays open during a lock.
- Point at a cell to light up the cells above and below it.
- The browser keeps the settings in `localStorage`. The app checks each stored value and uses the default for a value that is not valid.

## Online play

- Choose Online to create a session. The page shows a 4 character code and puts it in the link (`?code=AB3K`). Share link sends the link, or copies it when the device cannot share.
- Codes use letters and digits without `0`, `O`, `1` and `I`, so a code read aloud is not ambiguous.
- The creator plays X. The first other browser that opens the code plays O. Further browsers watch.
- A browser keeps its seat through a random token in `localStorage`.
- A code loads the full session, finished games included. Either player can name the session and start the next game after a game ends.
- Hide board and Hide all but last move belong to the session. A change by either player applies to both players and to watchers. View and layout stay per screen.
- The server keeps the newest 10,000 sessions. A SQLite trigger deletes the oldest session (by creation time) when a new session goes past that limit.

## Code

- `src/game.ts`: board, lines, move validation, win and draw detection, undo.
- `src/ai.ts`: the three computer levels.
- `src/sound.ts`: synthesized sounds.
- `src/protocol.ts`: the contract between the page and the API (code format, names, response check).
- `src/online.ts`: the API client and the live update stream.
- `src/main.ts`, `src/style.css`, `index.html`: the page.
- `server/main.ts`: the HTTP API and server-sent events. `server/store.ts`: the SQLite store.

The page is plain TypeScript built with Vite. The API runs on Node 24, which runs TypeScript directly, with the built-in `node:sqlite`. Neither has runtime dependencies.

## Develop

Node is not necessary on the host. Run the commands in a container:

```sh
docker run --rm -v "$PWD":/app -w /app node:24-alpine sh -c 'npm ci && npm test && npm run build'
docker run --rm -it -p 5173:5173 -v "$PWD":/app -w /app node:24-alpine npx vite --host
```

`npm run build` runs the type check (`tsc`) before the Vite build. `npm run api` starts the API on port 8080 with `./dev.db`.

## Deploy

See [kitshn.md](kitshn.md). A push to `main` deploys production.
