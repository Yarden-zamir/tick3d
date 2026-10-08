// The game clocks and the time limit editor.
import {
  remaining,
  formatClock,
  hasLimit,
  isFlagged,
  type TimeControl,
  sameClock,
  describeClock,
  LIMIT_RANGE,
  formatDuration,
} from '../clock.ts';
import type { Player } from '../game.ts';
import { sounds } from '../sound.ts';
import { clocksEl, clockNote, element, clockSummary } from './dom.ts';
import { reject, showToast, showProblem } from './feedback.ts';
import { playerName, render } from './render.ts';
import { refresh, sendShownChange, withBusy } from './sessions.ts';
import { settings, saveSettings } from './settings.ts';
import { current, nowMs, page, nextClock, canChangeMatch, settingsLocked, shared, isLive, updateSession } from './state.ts';

let lastTickSecond: number | undefined;
let lastFlagRefresh = 0;

export function renderClocks(): void {
  const game = current();
  const left = remaining(game, nowMs());
  clocksEl.hidden = left === null || page.session === undefined;
  // A review keeps the box of the live clocks but does not show them, so the board does not move up (src/style.css).
  clocksEl.toggleAttribute('data-reviewing', page.review !== undefined);
  if (left === null) return;
  const live = game.status.kind === 'playing';
  clocksEl.querySelectorAll<HTMLElement>('[data-clock]').forEach((chip) => {
    const player: Player = chip.dataset.clock === 'X' ? 'X' : 'O';
    const active = live && game.turn === player && game.moves.length >= 2;
    const clock = left[player];
    // The game limit is the main figure. With both limits, the active player also sees the move limit.
    const main = clock.game ?? clock.move ?? clock.left;
    const both = clock.game !== null && clock.move !== null;
    chip.textContent = `${playerName(player)} · ${formatClock(main)}${both && active ? ` · move ${formatClock(clock.move ?? 0)}` : ''}`;
    chip.classList.toggle('active', active);
    chip.classList.toggle('low', active && clock.left <= 10_000);
    chip.classList.toggle('out', clock.left <= 0);
  });
  clockNote.hidden = !live || game.moves.length >= 2;
}

// Runs 5 times a second: redraws the clocks, ticks in the last 10 seconds, and ends a game on time.
export function tickClock(): void {
  renderClocks();
  const game = current();
  if (!hasLimit(game.clock) || game.status.kind !== 'playing') return;
  const now = nowMs();
  if (isFlagged(game, now)) {
    // The holder of the session (server, device or Nearby host) records the timeout when it
    // reads the session, so a refresh is enough in every mode.
    if (page.session !== undefined && now - lastFlagRefresh > 1000) {
      lastFlagRefresh = now;
      void refresh(page.session.code);
    }
    return;
  }
  const left = remaining(game, now)?.[game.turn].left;
  if (left === undefined || game.moves.length < 2 || left > 10_000) return;
  const second = Math.ceil(left / 1000);
  if (second !== lastTickSecond) {
    lastTickSecond = second;
    sounds.tick(second <= 3);
  }
}

// The editor shows minutes for the game limit and seconds for the move limit.
const LIMIT_SCALE: Record<LimitKind, number> = { perGame: 60, perMove: 1 };
type LimitKind = keyof TimeControl;
// The last value of each limit, so a limit that is switched off comes back with the same value.
const lastLimit: Record<LimitKind, number> = { perGame: 300, perMove: 30 };

function limitControls(kind: LimitKind) {
  const box = element(`[data-limit="${kind}"]`, HTMLDivElement);
  const on = box.querySelector('[data-limit-on]');
  const value = box.querySelector('[data-limit-value]');
  if (!(on instanceof HTMLInputElement) || !(value instanceof HTMLInputElement)) {
    throw new Error(`time limit editor for ${kind} is incomplete`);
  }
  const options = box.querySelector('.limit-options');
  const custom = box.querySelector('.limit-custom');
  if (!(options instanceof HTMLElement) || !(custom instanceof HTMLElement)) {
    throw new Error(`time limit editor for ${kind} is incomplete`);
  }
  return { on, value, options, custom, presets: [...box.querySelectorAll<HTMLButtonElement>('[data-preset]')] };
}

const limitEditors: Record<LimitKind, ReturnType<typeof limitControls>> = {
  perGame: limitControls('perGame'),
  perMove: limitControls('perMove'),
};

export function renderClockEditor(frozen: boolean): void {
  const next = nextClock();
  // A computer or friend game opens a session as the page starts, and that session's stored limit
  // replaces a change made before it opened. So the editor waits until the session is there.
  // Online and Nearby without a game stay open: there the limit applies to the next game made.
  const loading = page.session === undefined && (settings.mode === 'computer' || settings.mode === 'friend');
  const disabled = frozen || page.busy || loading || !canChangeMatch();
  for (const kind of ['perGame', 'perMove'] as const) {
    const { on, value, options, custom, presets } = limitEditors[kind];
    const seconds = next[kind];
    if (seconds !== null) lastLimit[kind] = seconds;
    on.checked = seconds !== null;
    on.disabled = disabled;
    // The choices show only while the limit is on.
    options.hidden = seconds === null;
    value.disabled = disabled;
    let onPreset = false;
    for (const preset of presets) {
      const pressed = Number(preset.dataset.preset) === seconds;
      onPreset ||= pressed;
      preset.setAttribute('aria-pressed', String(pressed));
      preset.disabled = disabled;
    }
    // A value that matches no quick pick is a custom value: the custom box shows it as selected.
    // With a quick pick selected, the custom box stays empty, so it never repeats the quick pick.
    const isCustom = seconds !== null && !onPreset;
    custom.classList.toggle('active', isCustom);
    if (document.activeElement !== value) value.value = isCustom ? String(seconds / LIMIT_SCALE[kind]) : '';
  }
  const game = current();
  const pending = game.status.kind === 'playing' && game.moves.length > 0 && !sameClock(game.clock, next);
  clockSummary.textContent = pending
    ? `This game: ${describeClock(game.clock)}. Next game: ${describeClock(next)}.`
    : describeClock(next);
}

function applyClock(clock: TimeControl): void {
  if (settingsLocked()) {
    render();
    return reject(undefined, 'locked');
  }
  if (sameClock(clock, nextClock())) return render();
  sounds.click();
  settings.clock = clock;
  saveSettings();
  if (page.session === undefined) return render();
  if (page.session.you === null) {
    render();
    return reject(undefined, 'spectator');
  }
  const { code, backend } = page.session;
  // A game keeps the limit it started with, so a change during a game starts with the next one.
  if (!shared() && isLive() && current().moves.length > 0) showToast('The new time limit starts with the next game.');
  // Show the change at once, as with moves. The answer replaces it, or a refresh undoes it on an error.
  updateSession({ ...page.session, clock });
  render();
  void withBusy(() => sendShownChange(code, () => backend.update(code, { clock })));
}

function setLimit(kind: LimitKind, seconds: number | null): void {
  const { min, max } = LIMIT_RANGE[kind];
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < min || seconds > max)) {
    const what = kind === 'perGame' ? 'The limit per player' : 'The limit per move';
    showProblem(`${what} goes from ${formatDuration(min)} to ${formatDuration(max)}.`);
    return render();
  }
  const next = nextClock();
  applyClock(kind === 'perGame' ? { ...next, perGame: seconds } : { ...next, perMove: seconds });
}

export function setupClocks(): void {
  for (const kind of ['perGame', 'perMove'] as const) {
    const { on, value, presets } = limitEditors[kind];
    on.addEventListener('change', () => setLimit(kind, on.checked ? lastLimit[kind] : null));
    value.addEventListener('change', () => {
      // An emptied custom box means no change.
      if (value.value.trim() === '') return render();
      const amount = Number(value.value.replace(',', '.'));
      setLimit(kind, Number.isFinite(amount) ? Math.round(amount * LIMIT_SCALE[kind]) : NaN);
    });
    for (const preset of presets) {
      preset.addEventListener('click', () => setLimit(kind, Number(preset.dataset.preset)));
    }
  }
}
