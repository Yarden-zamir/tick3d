// Play by voice in the game: when the microphone listens, and when a held note places a move.
// The speaker of the device must not feed the microphone, so the voice pauses while the game plays a sound.

// 'off' closes the microphone. 'paused' keeps it open but pauses the voice engine. 'listening' aims and places.
export type VoiceState = 'off' | 'paused' | 'listening';

// After a sound of the game ends, the room still echoes it for a moment.
export const SOUND_TAIL_MS = 300;
// A note on one cell for this long places the move. The Voice room (/sound-input) uses the same time.
export const HOLD_MS = 1000;

export type VoiceGate = {
  // The player turned play by voice on.
  on: boolean;
  visible: boolean;
  // This screen has a seat in the open game.
  seated: boolean;
  live: boolean;
  myTurn: boolean;
  // A move is on its way, the computer thinks, or the player looks at an old position.
  waiting: boolean;
  // The end of the last sound of the game and the time now, both in performance.now() milliseconds.
  soundUntil: number;
  now: number;
};

export function voiceState({ on, visible, seated, live, myTurn, waiting, soundUntil, now }: VoiceGate): VoiceState {
  if (!on || !visible || !seated || !live) return 'off';
  if (!myTurn || waiting || now < soundUntil + SOUND_TAIL_MS) return 'paused';
  return 'listening';
}

// A held step places its move after HOLD_MS. `blockedStep` is the step of the last placed or refused
// move: one note places one move, also when the voice paused for the sounds of that move in between.
// Silence or another step ends the block.
export const holdPlaces = (step: number, heldMs: number, blockedStep: number | undefined): boolean => heldMs >= HOLD_MS && step !== blockedStep;
