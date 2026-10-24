// The runs of wins of this device. Two wins in a row against any opponent earn the name prompt
// (src/page/identity-nudge.ts).
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

// `wins`: wins in a row against any opponent: the computer at any level, online or Nearby.
// `easyWins`: wins in a row against easy so far. `earned`: two wins came, and the move up waits.
// `done`: this device moved up once (or the player left easy by choice), so it never moves up again.
type LevelUp = { wins: number; easyWins: number; earned: boolean; done: boolean };

const difficultyField = element('#difficulty-field', HTMLDivElement);

function load(): LevelUp {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.levelUp) ?? 'null');
    if (typeof raw === 'object' && raw !== null && 'easyWins' in raw && 'done' in raw) {
      const { easyWins, done } = raw;
      // A value from before `earned` existed reads as not earned yet.
      const earned = 'earned' in raw ? raw.earned : false;
      // A value from before `wins` existed starts the run at none.
      const wins = 'wins' in raw ? raw.wins : 0;
      const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
      if (count(wins) && count(easyWins) && typeof done === 'boolean' && typeof earned === 'boolean') {
        return { wins, easyWins, earned, done };
      }
    }
  } catch {
    // A broken value starts over.
  }
  return { wins: 0, easyWins: 0, earned: false, done: false };
}

function save(state: LevelUp): void {
  try {
    localStorage.setItem(STORAGE_KEYS.levelUp, JSON.stringify(state));
  } catch {
    // Without storage the move up can come again in a later visit. That is harmless.
  }
}

// A finished game where this screen held a seat. `computer` is the level of a game against the computer.
// A loss or a draw ends both runs. A game that is not against easy ends the run against easy.
export function noteResult(won: boolean, computer: Difficulty | undefined): void {
  const state = load();
  const wins = won ? state.wins + 1 : 0;
  if (state.done) return save({ ...state, wins });
  const easyWins = computer === 'easy' && won ? state.easyWins + 1 : 0;
  save({ wins, easyWins, earned: state.earned || easyWins >= WINS_TO_MOVE_UP, done: false });
}

export const winsInARow = (): number => load().wins;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let running = false;

// An end card closed. When the move up is earned and the player is on easy against the computer, it runs now.
// The promise settles when the move up is over (or did not run), so a later prompt does not cover it.
export async function runLevelUp(): Promise<void> {
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
  await wait(SCROLL_MS);
  const stillThere = !tookOver && settings.mode === 'computer' && settings.difficulty === 'easy';
  if (stillThere) {
    const medium = difficultyField.querySelector('[data-value="medium"]');
    if (!(medium instanceof HTMLButtonElement)) throw new Error('the Difficulty field has no Medium button');
    medium.click();
    // A game can end during the wait, so the save reads the runs again.
    save({ ...load(), done: true });
    difficultyField.classList.remove('level-up');
    void difficultyField.offsetWidth; // restart the animation
    difficultyField.classList.add('level-up');
    showToast('Two wins in a row against Easy. Up to Medium!');
    await wait(POP_MS);
  }
  running = false;
  for (const type of TAKE_OVER_EVENTS) removeEventListener(type, takeOver, { capture: true });
  if (!tookOver) scrollTo({ top: startY, behavior: scrollMotion() });
}
