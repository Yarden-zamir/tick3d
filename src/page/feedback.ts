// Toasts, problem messages and refused moves.
import type { MoveError } from '../game.ts';
import { RpcError } from '../nearby/rpc.ts';
import { OnlineError } from '../online.ts';
import { SessionError } from '../session/core.ts';
import { sounds } from '../sound.ts';
import { cellButton } from './board.ts';
import { toastEl } from './dom.ts';

type Refusal =
  | MoveError
  | 'wait'
  | 'not-your-turn'
  | 'spectator'
  | 'reviewing'
  | 'no-session'
  | 'locked';
const REFUSAL_TEXT: Record<Refusal, string> = {
  occupied: 'That cell is taken. Pick an empty cell.',
  'game-over': 'The game is over. Start a new game.',
  wait: 'Wait for the computer to move.',
  'not-your-turn': 'It is not your turn.',
  spectator: 'You are watching. Both seats are taken.',
  reviewing: 'You are looking at an old position. Go back to the live game first.',
  'no-session': 'Start a game, or join one with a code, first.',
  locked: 'Settings are locked until this game ends.',
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(text: string, tone: 'info' | 'problem' = 'info'): void {
  toastEl.textContent = text;
  toastEl.dataset.tone = tone;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// Plain HTTP (a laptop host) has no clipboard API. The copy then fails, and the caller says so.
export function copyText(text: string): Promise<void> {
  return navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'));
}

// A refused action: the error sound and a message in the problem style.
export function showProblem(text: string): void {
  sounds.invalid();
  showToast(text, 'problem');
}

// Errors from the server, the device rules and the Nearby host are fit to show. Anything else is a bug.
export function showError(error: unknown): void {
  if (!(error instanceof OnlineError) && !(error instanceof SessionError) && !(error instanceof RpcError)) throw error;
  showProblem(error.message);
}

export function reject(cell: number | undefined, reason: Refusal): void {
  showProblem(REFUSAL_TEXT[reason]);
  if (cell === undefined) return;
  const button = cellButton(cell);
  button.classList.remove('shake');
  void button.offsetWidth; // restart the animation
  button.classList.add('shake');
}
