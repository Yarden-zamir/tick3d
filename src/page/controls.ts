// The settings controls, review, new game, undo, lock and sound.
import { DIFFICULTIES } from '../ai.ts';
import { onSegmented } from '../board/view-controls.ts';
import { setMuted, sounds } from '../sound.ts';
import { reviewEl, newGameButton, undoButton, lockButton, seatLockButtons, soundButton, watcherChatButton } from './dom.ts';
import { reject, showError, showToast } from './feedback.ts';
import { nearbyKind, endNearby, openNearby } from './nearby.ts';
import { render } from './render.ts';
import { leaveSession, createSession, openLocalSession, withBusy, applyView, startNewGame, seatLockText, watcherChatText, undoMove } from './sessions.ts';
import { LAYOUTS, type MatchOptions, VIEWS } from '../protocol.ts';
import { settings, oneOf, HIDE_STEPS, MODES, type Mode, PLAYERS, saveSettings } from './settings.ts';
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
    case 'difficulty': {
      const level = oneOf(DIFFICULTIES, value, settings.difficulty);
      // The level announces itself, so the press plays this sound instead of the click (src/click-sound.ts).
      if (level !== settings.difficulty) sounds.difficulty(level);
      settings.difficulty = level;
      break;
    }
    case 'human':
      settings.human = oneOf(PLAYERS, value, settings.human);
      break;
    default:
      throw new Error(`unknown setting ${setting}`);
  }
  saveSettings();
  if (setting === 'view' || setting === 'layout') return render();
  void openMode(previousMode);
}

// Opens the mode of the settings after a change from `previousMode`. A local game stays on the device, so a
// switch loses nothing and asks nothing.
function openMode(previousMode: Mode): Promise<void> {
  if (previousMode === 'nearby' && nearbyKind() !== 'idle') endNearby();
  leaveSession();
  render();
  if (settings.mode === 'online') return previousMode === 'online' ? Promise.resolve() : createSession();
  if (settings.mode === 'nearby') {
    openNearby();
    return Promise.resolve();
  }
  // Each match-up continues its newest session on this device, or starts one.
  return openLocalSession(settings.mode).catch(showError);
}

// "Play online with a friend" in the Share menu: a new online game, as the Online choice of the Opponent picker
// starts one. An open online game stays, so the menu shares its link.
export async function startOnlineGame(): Promise<void> {
  if (page.session?.mode === 'online') return;
  const previousMode = settings.mode;
  settings.mode = 'online';
  saveSettings();
  // Online mode without a session: its create failed before, as after "New code" offline.
  await (previousMode === 'online' ? createSession() : openMode(previousMode));
}

export function setupControls(): void {
  onSegmented(document, changeSetting);

  // Hide goes in steps: each step hides what the steps before it hide (see HIDE_STEPS).
  document.querySelectorAll<HTMLButtonElement>('[data-hide-level]').forEach((button) => {
    const level = Number(button.dataset.hideLevel);
    if (!Number.isInteger(level) || level < 0 || level > HIDE_STEPS.length) throw new Error(`unknown hide level ${button.dataset.hideLevel}`);
    button.addEventListener('click', () => {
      if (settingsLocked()) return reject(undefined, 'locked');
      if (page.session === undefined) return reject(undefined, 'no-session');
      if (page.session.you === null) return reject(undefined, 'spectator');
      const { code, backend, options } = page.session;
      const changes: Partial<MatchOptions> = {};
      HIDE_STEPS.forEach((option, index) => {
        if (options[option] !== index < level) changes[option] = index < level;
      });
      if (Object.keys(changes).length === 0) return;
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
