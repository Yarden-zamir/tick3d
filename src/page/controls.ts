// The settings controls, review, new game, undo, lock and sound.
import { DIFFICULTIES } from '../ai.ts';
import { sounds, setMuted } from '../sound.ts';
import { undoMove } from './computer.ts';
import { reviewEl, newGameButton, undoButton, lockButton, soundButton } from './dom.ts';
import { reject, showError } from './feedback.ts';
import { infoButton } from '../header/header.ts';
import { nearbyKind, endNearby, openNearby } from './nearby.ts';
import { render } from './render.ts';
import { leaveSession, createSession, openLocalSession, withBusy, applyView, startNewGame } from './sessions.ts';
import { LAYOUTS, MATCH_OPTIONS, VIEWS } from '../protocol.ts';
import { settings, oneOf, MODES, PLAYERS, saveSettings } from './settings.ts';
import { page, settingsLocked, isLive } from './state.ts';

export function startReview(index: number): void {
  const game = page.games[index];
  if (game === undefined) throw new RangeError(`no game ${index}`);
  page.review = { game: index, move: game.moves.length };
  sounds.click();
  render();
}

function stepReview(action: string | undefined): void {
  if (page.review === undefined) return;
  const total = page.games[page.review.game]?.moves.length ?? 0;
  const moves: Record<string, number> = { first: 0, prev: page.review.move - 1, next: page.review.move + 1, last: total };
  if (action === 'exit') page.review = undefined;
  else if (action !== undefined && action in moves) {
    page.review = { ...page.review, move: Math.min(total, Math.max(0, moves[action] ?? page.review.move)) };
  } else throw new Error(`unknown review action ${action}`);
  sounds.click();
  render();
}

function changeSetting(setting: string, value: string | undefined): void {
  if (settingsLocked()) return reject(undefined, 'locked');
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
  sounds.click();
  if (setting === 'view' || setting === 'layout') return render();
  if (previousMode === 'nearby' && nearbyKind() !== 'idle') endNearby();
  leaveSession();
  page.review = undefined;
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
  // The Info popover opens without a script (src/header/header.ts). The game adds its click sound.
  infoButton.addEventListener('click', () => sounds.click());

  document.querySelectorAll<HTMLElement>('.segmented').forEach((group) => {
    const setting = group.dataset.setting;
    if (setting === undefined) throw new Error('segmented control without data-setting');
    group.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.getAttribute('aria-pressed') === 'true') return;
        changeSetting(setting, button.dataset.value);
      });
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((button) => {
    const toggle = button.dataset.toggle;
    const option = MATCH_OPTIONS.find((known) => known === toggle);
    if (option === undefined) throw new Error(`unknown toggle ${toggle}`);
    button.addEventListener('click', () => {
      if (settingsLocked()) return reject(undefined, 'locked');
      if (page.session === undefined) return reject(undefined, 'no-session');
      if (page.session.you === null) return reject(undefined, 'spectator');
      sounds.click();
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

  lockButton.addEventListener('click', () => {
    if (!isLive() || page.review || settingsLocked() || page.session === undefined) return;
    if (page.session.you === null) return reject(undefined, 'spectator');
    sounds.click();
    const { code, backend } = page.session;
    void withBusy(async () => applyView(await backend.lock(code)));
  });

  soundButton.addEventListener('click', () => {
    settings.muted = !settings.muted;
    setMuted(settings.muted);
    saveSettings();
    sounds.click();
    render();
  });
}
