# tick3d

3D tic-tac-toe on a 4×4×4 cube, at [tick3d.yarden-zamir.com](https://tick3d.yarden-zamir.com).
It replaces the Lovable version at [3tees.yarden-zamir.com](https://3tees.yarden-zamir.com) ([voice-quad-checkers-arena](https://github.com/Yarden-zamir/voice-quad-checkers-arena)).

## Rules

- Two players take turns. X moves first.
- Four marks in a straight line win. There are 76 lines: 48 along an axis, 24 diagonals inside a plane, and 4 through the cube.
- A full cube with no line is a draw.

## Features

- Play against a friend on one device, or against the computer.
- The computer has three levels:
  - Easy: takes a win when it sees one, otherwise plays a random cell.
  - Medium: takes a win, blocks your win, otherwise picks one of its three best cells.
  - Hard: takes a win, blocks your win, otherwise searches ahead with alpha-beta pruning for up to 600 ms.
- Move validation: an occupied cell, a move after the game ends, or a move during the computer turn is refused with a sound and a message.
- Sound effects made with Web Audio. Each layer has its own note. A mute button keeps the choice.
- Two views: a 3D tower of tilted layers and a flat view of the four layers.
- Point at a cell to light up the cells above and below it.
- The browser keeps the settings in `localStorage`. The app checks each stored value and uses the default for a value that is not valid.

## Code

- `src/game.ts`: board, lines, move validation, win and draw detection, undo.
- `src/ai.ts`: the three computer levels.
- `src/sound.ts`: synthesized sounds.
- `src/main.ts`, `src/style.css`, `index.html`: the page.

The app is plain TypeScript built with Vite. It has no runtime dependencies.

## Develop

Node is not necessary on the host. Run the commands in a container:

```sh
docker run --rm -v "$PWD":/app -w /app node:24-alpine sh -c 'npm ci && npm test && npm run build'
docker run --rm -it -p 5173:5173 -v "$PWD":/app -w /app node:24-alpine npx vite --host
```

`npm run build` runs the type check (`tsc`) before the Vite build.

## Deploy

See [kitshn.md](kitshn.md). A push to `main` deploys production.
