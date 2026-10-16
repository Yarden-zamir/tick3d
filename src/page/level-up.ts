// The first time a player wins twice in a row against easy, the page moves them up to medium, once.
// It scrolls to Difficulty, presses Medium as the player would, and makes the field pop, so the change is clear.
// Then it scrolls back to where the player was, unless the player scrolled, pressed or typed meanwhile.
// It runs when the end card of the second win closes. Limit: a win whose end card never opens (another
// dialog was open) waits for the next end card. Revisit if players report a late move up.
import type { Difficulty } from '../ai.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import { element } from './dom.ts';
import { showToast } from './feedback.ts';

const WINS_TO_MOVE_UP = 2;
// The wait for the smooth scroll to Difficulty, and the length of the pop (two runs of .level-up in src/style.css).
const SCROLL_MS = 700;
const POP_MS = 3200;
// What a player does to take over the page. A scroll event alone does not count: the smooth scroll of
// this module sends scroll events too.
const TAKE_OVER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

// `easyWins`: wins in a row against easy so far. `done`: this device moved up once, so it never moves up again.
type LevelUp = { easyWins: number; done: boolean };

const difficultyField = element('#difficulty-field', HTMLDivElement);

function load(): LevelUp {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.levelUp) ?? 'null');
    if (typeof raw === 'object' && raw !== null && 'easyWins' in raw && 'done' in raw) {
      const { easyWins, done } = raw;
      if (Number.isInteger(easyWins) && typeof easyWins === 'number' && easyWins >= 0 && typeof done === 'boolean') return { easyWins, done };
    }
  } catch {
    // A broken value starts over.
  }
  return { easyWins: 0, done: false };
}

function save(state: LevelUp): void {
  try {
    localStorage.setItem(STORAGE_KEYS.levelUp, JSON.stringify(state));
  } catch {
    // Without storage the move up can come again in a later visit. That is harmless.
  }
}

let pending = false;

// A finished game against the computer. A loss, a draw or another level ends the run of wins.
export function noteComputerResult(difficulty: Difficulty, won: boolean): void {
  const state = load();
  if (state.done) return;
  const easyWins = difficulty === 'easy' && won ? state.easyWins + 1 : 0;
  pending = easyWins >= WINS_TO_MOVE_UP;
  save({ easyWins, done: pending });
}

// The end card closed. When the move up waits, it runs now.
export function runLevelUp(): void {
  if (!pending) return;
  pending = false;
  const startY = scrollY;
  let tookOver = false;
  const takeOver = () => {
    tookOver = true;
  };
  for (const type of TAKE_OVER_EVENTS) addEventListener(type, takeOver, { capture: true, passive: true });
  difficultyField.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // The press waits for the scroll, so the player sees the switch move to Medium.
  setTimeout(() => {
    const medium = difficultyField.querySelector('[data-value="medium"]');
    if (!(medium instanceof HTMLButtonElement)) throw new Error('the Difficulty field has no Medium button');
    medium.click();
    difficultyField.classList.remove('level-up');
    void difficultyField.offsetWidth; // restart the animation
    difficultyField.classList.add('level-up');
    showToast('Two wins in a row against Easy. Up to Medium!');
  }, SCROLL_MS);
  setTimeout(() => {
    for (const type of TAKE_OVER_EVENTS) removeEventListener(type, takeOver, { capture: true });
    if (!tookOver) scrollTo({ top: startY, behavior: 'smooth' });
  }, SCROLL_MS + POP_MS);
}
