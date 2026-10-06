// The computer turn and undo, for games on this device.
import { hasLimit } from '../clock.ts';
import { type Game, type Player, other } from '../game.ts';
import { createSearch } from '../move-search.ts';
import { sounds } from '../sound.ts';
import { computerTuning } from './advanced.ts';
import { showError, reject } from './feedback.ts';
import { requestUndo } from './players.ts';
import { render } from './render.ts';
import { applyView, withBusy } from './sessions.ts';
import { settings } from './settings.ts';
import { page, isLive, current, settingsLocked, shared } from './state.ts';

const COMPUTER_DELAY_MS = 450;

// Every level searches in a Web Worker, so input and animations keep running while the computer thinks.
// Vite builds src/ai-worker.ts as its own chunk, and the service worker precaches it for offline play.
// A browser that cannot start a module worker throws here, and the search then runs on the main thread.
const search = createSearch(() => new Worker(new URL('../ai-worker.ts', import.meta.url), { type: 'module' }));

const isComputerTurn = () =>
  page.session?.mode === 'computer' && page.session.you !== null && isLive() && current().turn !== page.session.you;

// How many moves `player` made in `game`.
const movesBy = (game: Game, player: Player) =>
  game.moves.filter((_, i) => (i % 2 === 0 ? game.first : other(game.first)) === player).length;

export function scheduleComputer(): void {
  if (!isComputerTurn() || page.session === undefined || page.session.you === null || page.thinking) return;
  const backend = page.local;
  if (backend === undefined) throw new Error('a computer game without the device backend');
  page.thinking = true;
  render();
  const { code } = page.session;
  const computer = other(page.session.you);
  const scheduledRound = page.round;
  // A new game, an undo or a session switch increments the round and clears `thinking` itself.
  // A stale step then only stops, so it does not clear `thinking` for the next computer turn.
  const stale = () => scheduledRound !== page.round || page.session?.code !== code;
  setTimeout(() => {
    if (stale()) return;
    if (!isComputerTurn()) {
      page.thinking = false;
      return render();
    }
    const game = current();
    const startedMs = performance.now();
    void (async () => {
      try {
        const cell = await search(game.board, game.turn, settings.difficulty, computerTuning());
        const thinkMs = Math.round(performance.now() - startedMs);
        // The game can end during the search, for example on time.
        if (stale() || !isComputerTurn()) return;
        const request = { game: page.games.length - 1, moveCount: game.moves.length, cell };
        const view = await backend.computerMove(code, request);
        if (stale()) return;
        // A game that this page opened after a reload has no times for the earlier moves. The list then
        // stays shorter than the move count, and the index still matches the computer's move order.
        if (page.computerThinkMs.length === movesBy(game, computer)) page.computerThinkMs = [...page.computerThinkMs, thinkMs];
        page.thinking = false;
        applyView(view);
      } catch (error) {
        if (!stale()) showError(error);
      } finally {
        if (!stale()) page.thinking = false;
        render();
      }
    })();
  }, COMPUTER_DELAY_MS);
}

export function undoMove(): void {
  // With another device, the other player must accept an undo.
  if (shared()) return requestUndo();
  const backend = page.local;
  if (page.session === undefined || backend === undefined || (page.session.mode !== 'computer' && page.session.mode !== 'friend')) return;
  if (page.thinking || page.review || !isLive() || current().moves.length === 0) return;
  // Undo would hand back time that the clock already counted, so a timed game has no undo.
  if (hasLimit(current().clock)) return;
  if (settingsLocked()) return reject(undefined, 'locked');
  // Against the computer, go back to the last position where it was the human's turn.
  const you = page.session.you;
  const count = page.session.mode === 'computer' && current().turn === you && current().moves.length >= 2 ? 2 : 1;
  page.round++;
  const { code } = page.session;
  sounds.click();
  void withBusy(async () => {
    applyView(await backend.undo(code, count));
    // Keep the think times of the computer moves that are still on the board.
    if (you !== null) page.computerThinkMs = page.computerThinkMs.slice(0, movesBy(current(), other(you)));
  }).then(scheduleComputer);
}
