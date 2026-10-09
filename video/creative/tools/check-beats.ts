// Checks video/creative/beats.json against the game code. Run from the repo root:
//   docker run --rm -v "$PWD":/repo -w /repo node:26-alpine node video/creative/tools/check-beats.ts
// It exits with an error on the first broken rule.
import { readFileSync, readdirSync } from 'node:fs';
import { chooseMove } from '../../../src/ai.ts';
import { LINES, linesThrough, newGame, play, replay } from '../../../src/game.ts';
import { seededRandom } from '../../../src/practice/practice.ts';
import { BAR_COUNT, type Beats, SIXTEENTHS_PER_BAR, SPOT_SIXTEENTHS, parseBeats, withVariant } from '../beats.ts';

function check(ok: boolean, rule: string): void {
  if (!ok) throw new Error(`beats.json breaks a rule: ${rule}`);
}

const beatsJson: unknown = JSON.parse(readFileSync(new URL('../beats.json', import.meta.url), 'utf8'));
const beats = parseBeats(beatsJson);
// The variant overlays (../variants/*.json). checkTimeline checks each one merged into beats.json.
const variantsDir = new URL('../variants/', import.meta.url);
const variantFiles = readdirSync(variantsDir).filter((file) => file.endsWith('.json')).sort();
const css = readFileSync(new URL('../../../src/style.css', import.meta.url), 'utf8');

// Every rule below holds for beats.json and for each variant merged into it.
function checkTimeline(beats: Beats, name: string): void {
  const rule = (ok: boolean, text: string) => check(ok, `${name}: ${text}`);
  // The game is the self-play of src/ai.ts with the seed, move for move.
  const random = seededRandom(beats.game.seed);
  let game = newGame(beats.game.first);
  while (game.status.kind === 'playing') {
    const result = play(game, chooseMove(game.board, game.turn, beats.game.levels[game.turn], random));
    if (!result.ok) throw new Error(`self-play made an illegal move: ${result.error}`);
    game = result.game;
  }
  rule(JSON.stringify(game.moves) === JSON.stringify(beats.moves.map((m) => m.cell)), 'the moves are the self-play game of the seed');

  // replay() throws on an illegal move. The game must end with the win on a real line.
  const final = replay(beats.moves.map((m) => m.cell), { first: beats.game.first });
  rule(final.status.kind === 'won' && final.status.winner === beats.game.winner, 'the game ends with a win of game.winner');
  rule(final.status.kind === 'won' && JSON.stringify(final.status.line) === JSON.stringify(beats.game.line), 'game.line is the winning line');
  rule(LINES.some((l) => JSON.stringify(l) === JSON.stringify(beats.game.line)), 'game.line is in LINES');

  beats.moves.forEach((move, i) => {
    rule(move.move === i, `moves[${i}].move is ${i}`);
    rule(move.player === (i % 2 === 0 ? beats.game.first : beats.game.first === 'X' ? 'O' : 'X'), `moves[${i}] has the right player`);
    rule(i === 0 || move.at > (beats.moves[i - 1]?.at ?? Infinity), `moves[${i}] comes after the move before`);
  });

  rule(beats.bars.length === BAR_COUNT, `${BAR_COUNT} bars`);
  beats.bars.forEach((bar, i) => {
    rule(bar.bar === i + 1 && bar.start === i * SIXTEENTHS_PER_BAR, `bars[${i}] starts on its downbeat`);
    rule(bar.theme === 'light' || css.includes(`[data-theme='${bar.theme}']`), `bars[${i}].theme is in src/style.css`);
    for (const event of bar.events) {
      const inBar = event.at >= bar.start && event.at < bar.start + SIXTEENTHS_PER_BAR;
      rule(inBar || (event.kind === 'final-chord' && event.at === SPOT_SIXTEENTHS), `bars[${i}] ${event.kind} is inside its bar`);
      if (event.kind === 'beam') rule(JSON.stringify(event.line) === JSON.stringify(beats.game.line), 'the beam is the winning line');
      if (event.kind === 'threats') {
        // The threat cells are exactly the cells that win for the player of the last move at that time.
        const before = beats.moves.filter((m) => m.at <= event.at);
        const last = before.at(-1);
        rule(last !== undefined, 'a move comes before the threats');
        const board = replay(before.map((m) => m.cell), { first: beats.game.first }).board;
        const wins = new Set<number>();
        for (const c of board.keys()) {
          if (board[c] !== null) continue;
          if (linesThrough(c).some((l) => l.every((x) => x === c || board[x] === last?.player))) wins.add(c);
        }
        rule(JSON.stringify([...wins].sort((a, b) => a - b)) === JSON.stringify([...event.cells].sort((a, b) => a - b)), 'threats are the real winning cells');
      }
    }
  });

  // A threat pulse sits on an eighth note, on a cell that blinks then: a threat of an earlier event that no piece took yet.
  const threatsAt = (at: number) => beats.bars.flatMap((bar) => bar.events.flatMap((e) => (e.kind === 'threats' && e.at <= at ? [e] : [])));
  const takenBy = (cell: number, at: number) => beats.moves.some((m) => m.cell === cell && m.at <= at);
  for (const event of beats.bars.flatMap((bar) => bar.events)) {
    if (event.kind !== 'threat-pulse') continue;
    rule(event.at % 2 === 0, `the threat pulse at ${event.at} is on an eighth note`);
    rule(event.cells.length > 0, `the threat pulse at ${event.at} has cells`);
    for (const cell of event.cells) {
      rule(threatsAt(event.at).some((t) => t.cells.includes(cell)), `cell ${cell} is a threat at ${event.at}`);
      rule(!takenBy(cell, event.at), `cell ${cell} is still empty at ${event.at}`);
    }
  }
  // The win jingle comes once, after the winning move, in its bar.
  const jingles = beats.bars.flatMap((bar) => bar.events.filter((e) => e.kind === 'win-jingle').map((e) => ({ bar, e })));
  rule(jingles.length === 1, 'exactly one win jingle');
  const winAt = beats.moves.at(-1)?.at ?? Infinity;
  rule(jingles.every(({ bar, e }) => e.at > winAt && bar.start <= winAt), 'the win jingle follows the winning move in its bar');

  rule(beats.text.length <= 3, 'at most 3 on-screen lines');
  for (const [i, entry] of beats.text.entries()) {
    rule(entry.words.every((w) => w.at < entry.until), `text[${i}] words come before the line leaves`);
  }
  // The hit points of the maintainer audio rule on #119: bar 1 downbeat, the win on bar 5, the end card on bar 7.
  const barStart = (bar: number) => (bar - 1) * SIXTEENTHS_PER_BAR;
  rule(beats.bars[0]?.events.some((e) => e.at === 0) === true, 'a hit on the bar 1 downbeat');
  rule(beats.moves.at(-1)?.at === barStart(5), 'the winning move lands on the bar 5 downbeat');
  rule(beats.text.at(-1)?.words[0]?.at === barStart(7), 'the end card lands on the bar 7 downbeat');
}

checkTimeline(beats, 'beats.json');
for (const file of variantFiles) checkTimeline(parseBeats(withVariant(beatsJson, JSON.parse(readFileSync(new URL(file, variantsDir), 'utf8')))), `variants/${file}`);

process.stdout.write(`beats.json and every variant ok: ${beats.moves.length} legal moves, ${beats.game.winner} wins on line ${beats.game.line.join('-')}, ${variantFiles.length} variants\n`);
