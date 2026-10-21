// The first time a player wins twice in a row against easy, the page moves them up to medium, once.
// It scrolls to Difficulty, presses Medium as the player would, and makes the field pop, so the change is clear.
// Then it scrolls back to where the player was, unless the player scrolled, pressed or typed meanwhile.
// The two wins earn the move up, and storage keeps it, so a reload does not lose it. It runs when an end card
// closes on easy against the computer, and it counts as done only once Medium is pressed. A player who takes
// over the page during the scroll, or who left easy or the computer, keeps it for the next end card.
import type { Difficulty } from '../ai.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import { element, scrollMotion } from './dom.ts';
import { showToast } from './feedback.ts';
import { settings } from './settings.ts';

const WINS_TO_MOVE_UP = 2;
// The wait for the scroll to Difficulty, and the length of the pop (two runs of .level-up in src/style.css).
const SCROLL_MS = 700;
const POP_MS = 3200;
// What a player does to take over the page. A scroll event alone does not count: the smooth scroll of
// this module sends scroll events too.
const TAKE_OVER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

// `easyWins`: wins in a row against easy so far. `earned`: two wins came, and the move up waits.
// `done`: this device moved up once (or the player left easy by choice), so it never moves up again.
type LevelUp = { easyWins: number; earned: boolean; done: boolean };

const difficultyField = element('#difficulty-field', HTMLDivElement);

function load(): LevelUp {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.levelUp) ?? 'null');
    if (typeof raw === 'object' && raw !== null && 'easyWins' in raw && 'done' in raw) {
      const { easyWins, done } = raw;
      // A value from before `earned` existed reads as not earned yet.
      const earned = 'earned' in raw ? raw.earned : false;
      if (Number.isInteger(easyWins) && typeof easyWins === 'number' && easyWins >= 0 && typeof done === 'boolean' && typeof earned === 'boolean') {
        return { easyWins, earned, done };
      }
    }
  } catch {
    // A broken value starts over.
  }
  return { easyWins: 0, earned: false, done: false };
}

function save(state: LevelUp): void {
  try {
    localStorage.setItem(STORAGE_KEYS.levelUp, JSON.stringify(state));
  } catch {
    // Without storage the move up can come again in a later visit. That is harmless.
  }
}

// A finished game against the computer. A loss, a draw or another level ends the run of wins.
export function noteComputerResult(difficulty: Difficulty, won: boolean): void {
  const state = load();
  if (state.done) return;
  const easyWins = difficulty === 'easy' && won ? state.easyWins + 1 : 0;
  save({ easyWins, earned: state.earned || easyWins >= WINS_TO_MOVE_UP, done: false });
}

let running = false;

// An end card closed. When the move up is earned and the player is on easy against the computer, it runs now.
export function runLevelUp(): void {
  const state = load();
  if (!state.earned || state.done || running || settings.mode !== 'computer') return;
  // The player left easy by choice: the move up has no point any more.
  if (settings.difficulty !== 'easy') return save({ ...state, done: true });
  running = true;
  const startY = scrollY;
  let tookOver = false;
  const takeOver = () => {
    tookOver = true;
  };
  for (const type of TAKE_OVER_EVENTS) addEventListener(type, takeOver, { capture: true, passive: true });
  difficultyField.scrollIntoView({ behavior: scrollMotion(), block: 'center' });
  // The press waits for the scroll, so the player sees the switch move to Medium.
  setTimeout(() => {
    const stillThere = !tookOver && settings.mode === 'computer' && settings.difficulty === 'easy';
    if (stillThere) {
      const medium = difficultyField.querySelector('[data-value="medium"]');
      if (!(medium instanceof HTMLButtonElement)) throw new Error('the Difficulty field has no Medium button');
      medium.click();
      save({ ...state, done: true });
      difficultyField.classList.remove('level-up');
      void difficultyField.offsetWidth; // restart the animation
      difficultyField.classList.add('level-up');
      showToast('Two wins in a row against Easy. Up to Medium!');
    }
    setTimeout(
      () => {
        running = false;
        for (const type of TAKE_OVER_EVENTS) removeEventListener(type, takeOver, { capture: true });
        if (!tookOver) scrollTo({ top: startY, behavior: scrollMotion() });
      },
      stillThere ? POP_MS : 0,
    );
  }, SCROLL_MS);
}
