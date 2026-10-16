// The computer turn, for games on this device.
import { type Game, type Player, other } from '../game.ts';
import { createSearch } from '../move-search.ts';
import { isTunedFor } from '../tuning.ts';
import { computerTuning } from './advanced.ts';
import { showError } from './feedback.ts';
import { render } from './render.ts';
import { applyView } from './sessions.ts';
import { settings } from './settings.ts';
import { page, isLive, current, currentRound, setThinking } from './state.ts';

const COMPUTER_DELAY_MS = 450;

// Every level searches in a Web Worker, so input and animations keep running while the computer thinks.
// Vite builds src/ai-worker.ts as its own chunk, and the service worker precaches it for offline play.
// A browser that cannot start a module worker, or cannot load its script offline, searches on the main thread.
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
  setThinking(true);
  render();
  const { code } = page.session;
  const computer = other(page.session.you);
  // A new screen or a new game starts a new round and clears `thinking` itself.
  // A stale step then only stops, so it does not clear `thinking` for the next computer turn.
  const stale = currentRound().isStale;
  setTimeout(() => {
    if (stale()) return;
    if (!isComputerTurn()) {
      setThinking(false);
      return render();
    }
    const game = current();
    const startedMs = performance.now();
    // The settings that choose this move. The game remembers changed ones, so its result counts as tuned.
    const difficulty = settings.difficulty;
    const tuning = computerTuning();
    void (async () => {
      try {
        const cell = await search(game.board, game.turn, difficulty, tuning);
        const thinkMs = Math.round(performance.now() - startedMs);
        // The game can end during the search, for example on time.
        if (stale() || !isComputerTurn()) return;
        const request = { game: page.games.length - 1, moveCount: game.moves.length, cell };
        const view = await backend.computerMove(code, request, isTunedFor(tuning, difficulty) ? tuning : null);
        if (stale()) return;
        // A game that this page opened after a reload has no times for the earlier moves. The list then
        // stays shorter than the move count, and the index still matches the computer's move order.
        if (page.computerThinkMs.length === movesBy(game, computer)) page.computerThinkMs = [...page.computerThinkMs, thinkMs];
        setThinking(false);
        applyView(view);
      } catch (error) {
        if (!stale()) showError(error);
      } finally {
        if (!stale()) setThinking(false);
        render();
      }
    })();
  }, COMPUTER_DELAY_MS);
}
