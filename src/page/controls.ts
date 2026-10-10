// The settings controls, review, new game, undo, lock and sound.
import { DIFFICULTIES } from '../ai.ts';
import { onSegmented } from '../board/view-controls.ts';
import { setMuted } from '../sound.ts';
import { undoMove } from './computer.ts';
import { reviewEl, newGameButton, undoButton, lockButton, seatLockButtons, soundButton, watcherChatButton } from './dom.ts';
import { reject, showError, showToast } from './feedback.ts';
import { nearbyKind, endNearby, openNearby } from './nearby.ts';
import { render } from './render.ts';
import { leaveSession, createSession, openLocalSession, withBusy, applyView, startNewGame, seatLockText, watcherChatText } from './sessions.ts';
import { LAYOUTS, MATCH_OPTIONS, VIEWS } from '../protocol.ts';
import { settings, oneOf, MODES, PLAYERS, saveSettings } from './settings.ts';
import { page, settingsLocked, isLive, setReview, shared } from './state.ts';

export function startReview(index: number): void {
  const game = page.games[index];
  if (game === undefined) throw new RangeError(`no game ${index}`);
  setReview({ game: index, move: game.moves.length });
  render();
}

function stepReview(action: string | undefined): void {
  if (page.review === undefined) return;
  const total = page.games[page.review.game]?.moves.length ?? 0;
  const moves: Record<string, number> = { first: 0, prev: page.review.move - 1, next: page.review.move + 1, last: total };
  if (action === 'exit') setReview(undefined);
  else if (action !== undefined && action in moves) {
    setReview({ ...page.review, move: Math.min(total, Math.max(0, moves[action] ?? page.review.move)) });
  } else throw new Error(`unknown review action ${action}`);
  render();
}

// The lock holds the rules of a game, not the screen or the way out: these settings stay open.
function changeSetting(setting: string, value: string | undefined): void {
  const previousMode = settings.mode;
  switch (setting) {
    case 'view':
      settings.view = oneOf(VIEWS, value, settings.view);
      break;
    case 'layout':
      settings.layout = oneOf(LAYOUTS, value, settings.layout);
      break;
    case 'mode':
      settings.mode = oneOf(MODES, value, settings.mode);
      break;
    case 'difficulty':
      settings.difficulty = oneOf(DIFFICULTIES, value, settings.difficulty);
      break;
    case 'human':
      settings.human = oneOf(PLAYERS, value, settings.human);
      break;
    default:
      throw new Error(`unknown setting ${setting}`);
  }
  saveSettings();
  if (setting === 'view' || setting === 'layout') return render();
  if (previousMode === 'nearby' && nearbyKind() !== 'idle') endNearby();
  leaveSession();
  render();
  if (settings.mode === 'online') {
    if (previousMode !== 'online') void createSession();
    return;
  }
  if (settings.mode === 'nearby') return openNearby();
  // Each match-up continues its newest session on this device, or starts one.
  void openLocalSession(settings.mode).catch(showError);
}

export function setupControls(): void {
  onSegmented(document, changeSetting);

  document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((button) => {
    const toggle = button.dataset.toggle;
    const option = MATCH_OPTIONS.find((known) => known === toggle);
    if (option === undefined) throw new Error(`unknown toggle ${toggle}`);
    button.addEventListener('click', () => {
      if (settingsLocked()) return reject(undefined, 'locked');
      if (page.session === undefined) return reject(undefined, 'no-session');
      if (page.session.you === null) return reject(undefined, 'spectator');
      const { code, backend } = page.session;
      const changes = { [option]: !page.session.options[option] };
      void withBusy(async () => applyView(await backend.update(code, changes)));
    });
  });

  reviewEl.querySelectorAll<HTMLButtonElement>('[data-review]').forEach((button) => {
    button.addEventListener('click', () => stepReview(button.dataset.review));
  });

  newGameButton.addEventListener('click', startNewGame);

  undoButton.addEventListener('click', undoMove);

  // The seat lock: on, X and O stay the same between games. Off, they swap after each game.
  for (const button of seatLockButtons) {
    button.addEventListener('click', () => {
      if (settingsLocked()) return reject(undefined, 'locked');
      if (page.session === undefined) return reject(undefined, 'no-session');
      if (page.session.you === null) return reject(undefined, 'spectator');
      const { code, backend } = page.session;
      const fixedSeats = !page.session.fixedSeats;
      void withBusy(async () => {
        applyView(await backend.update(code, { fixedSeats }));
        // With another device, applyView shows the message, as for every change of the match.
        if (!shared()) showToast(seatLockText(fixedSeats));
      });
    });
  }

  // Watcher chat: on, watchers can write in the chat. A lock leaves it open, so a player can turn it off mid-game.
  watcherChatButton.addEventListener('click', () => {
    if (page.session === undefined) return reject(undefined, 'no-session');
    if (page.session.you === null) return reject(undefined, 'spectator');
    const { code, backend } = page.session;
    const watcherChat = !page.session.watcherChat;
    void withBusy(async () => {
      applyView(await backend.update(code, { watcherChat }));
      if (!shared()) showToast(watcherChatText(watcherChat));
    });
  });

  lockButton.addEventListener('click', () => {
    if (!isLive() || page.review || page.session === undefined || page.session.locked) return;
    if (page.session.you === null) return reject(undefined, 'spectator');
    const { code, backend } = page.session;
    void withBusy(async () => applyView(await backend.lock(code)));
  });

  soundButton.addEventListener('click', () => {
    settings.muted = !settings.muted;
    setMuted(settings.muted);
    saveSettings();
    render();
  });
}
