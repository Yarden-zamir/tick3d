// Seeds an API with finished games through POST /api/results, so the read routes have realistic data.
// Usage: node bench/seed.ts <base url> <players> <games per player>
// The data is fixed (no randomness), so a seed of Node and a seed of Rust hold the same games.
import { tokenOf } from './tokens.ts';

const [base, playersText, gamesText] = process.argv.slice(2);
if (base === undefined || playersText === undefined || gamesText === undefined) throw new Error('usage: seed.ts <base> <players> <games>');
const players = Number(playersText);
const games = Number(gamesText);

// Three finished games: X wins on a row, O wins on a row, X wins on a space diagonal.
const LINES = [
  [0, 16, 1, 17, 2, 18, 3],
  [4, 0, 5, 1, 6, 2, 32, 3],
  [0, 1, 21, 2, 42, 3, 63],
];
const LEVELS = ['easy', 'medium', 'hard'] as const;
const START = Date.now() - 20 * 86_400_000;

function upload(player: number, game: number) {
  const moves = LINES[(player + game) % LINES.length] as number[];
  const finishedAt = START + (player * games + game) * 997;
  const friend = game % 5 === 4;
  return {
    // A result id has 16 to 64 characters from a-z, 0-9 and "-".
    id: `bench-${String(player).padStart(8, "0")}-${String(game).padStart(6, "0")}`,
    mode: friend ? 'friend' : 'computer',
    game: { moves, times: moves.map((_, i) => finishedAt - (moves.length - i) * 900), clock: { perMove: null, perGame: null }, timedOut: false },
    you: friend ? null : game % 2 === 0 ? 'X' : 'O',
    difficulty: friend ? null : LEVELS[game % 3],
    finishedAt,
    options: { hideBoard: game % 7 === 0, hideHistory: false, hideCoordinates: false },
    tuned: false,
    metrics: {
      device: game % 2 === 0 ? 'phone' : 'computer', view: 'tower', layout: 'grid', theme: 'dark',
      input: { board: 6, keypad: 1, voice: 0 }, refused: {}, undos: game % 3, thinkMs: [20, 35], offline: false, version: 'main-bench1', tuning: null, nearby: null,
    },
  };
}

const started = Date.now();
for (let player = 0; player < players; player++) {
  for (let first = 0; first < games; first += 100) {
    const results = Array.from({ length: Math.min(100, games - first) }, (_, i) => upload(player, first + i));
    const response = await fetch(`${base}/api/results`, {
      method: 'POST',
      headers: { 'x-player': tokenOf(player), 'content-type': 'application/json' },
      body: JSON.stringify({ results }),
    });
    if (!response.ok) throw new Error(`seed: ${response.status} ${await response.text()}`);
  }
}
console.log(`seeded ${players * games} games for ${players} players in ${Date.now() - started} ms`);
