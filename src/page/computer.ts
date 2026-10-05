// The computer turn and undo, for games on this device.
import { chooseMove } from '../ai.ts';
import { hasLimit } from '../clock.ts';
import { sounds } from '../sound.ts';
import { computerTuning } from './advanced.ts';
import { showError, reject } from './feedback.ts';
import { render } from './render.ts';
import { applyView, withBusy } from './sessions.ts';
import { settings } from './settings.ts';
import { page, isLive, current, settingsLocked } from './state.ts';

const COMPUTER_DELAY_MS = 450;

const isComputerTurn = () =>
  page.session?.mode === 'computer' && page.session.you !== null && isLive() && current().turn !== page.session.you;

export function scheduleComputer(): void {
  if (!isComputerTurn() || page.session === undefined || page.thinking) return;
  const backend = page.local;
  if (backend === undefined) throw new Error('a computer game without the device backend');
  page.thinking = true;
  render();
  const { code } = page.session;
  const scheduledRound = page.round;
  setTimeout(() => {
    if (scheduledRound !== page.round || page.session?.code !== code || !isComputerTurn()) {
      page.thinking = false;
      return render();
    }
    // The hard level searches on the main thread for its thinking time: 600 ms by default, at most
    // 1000 ms in the advanced settings. CSS animations keep running, but input waits. Move the search
    // to a Web Worker if that limit grows past about one second.
    const game = current();
    const cell = chooseMove(game.board, game.turn, settings.difficulty, Math.random, computerTuning());
    const request = { game: page.games.length - 1, moveCount: game.moves.length, cell };
    void (async () => {
      try {
        const view = await backend.computerMove(code, request);
        page.thinking = false;
        applyView(view);
      } catch (error) {
        showError(error);
      } finally {
        page.thinking = false;
        render();
      }
    })();
  }, COMPUTER_DELAY_MS);
}

export function undoMove(): void {
  const backend = page.local;
  if (page.session === undefined || backend === undefined || (page.session.mode !== 'computer' && page.session.mode !== 'friend')) return;
  if (page.thinking || page.review || !isLive() || current().moves.length === 0) return;
  // Undo would hand back time that the clock already counted, so a timed game has no undo.
  if (hasLimit(current().clock)) return;
  if (settingsLocked()) return reject(undefined, 'locked');
  // Against the computer, go back to the last position where it was the human's turn.
  const count = page.session.mode === 'computer' && current().turn === page.session.you && current().moves.length >= 2 ? 2 : 1;
  page.round++;
  const { code } = page.session;
  sounds.click();
  void withBusy(async () => applyView(await backend.undo(code, count))).then(scheduleComputer);
}
