import { type Player, toCoords } from './game.ts';

// All sounds are synthesized with Web Audio, so the app ships no audio files.
let context: AudioContext | undefined;
let muted = false;

export function setMuted(value: boolean): void {
  muted = value;
}

function audio(): AudioContext | undefined {
  if (muted || typeof AudioContext === 'undefined') return undefined;
  context ??= new AudioContext();
  // Browsers start the context suspended until a user gesture. A sound without a gesture (a chat
  // message or the other player's move before the first tap) is skipped: a suspended context would
  // queue it and play it late, together with the next sounds.
  if (context.state === 'suspended') {
    // Safari before 16.4 has no userActivation, and then plays the sound as before.
    if (navigator.userActivation && !navigator.userActivation.isActive) return undefined;
    void context.resume();
  }
  return context;
}

type Tone = { frequency: number; at?: number; duration: number; type?: OscillatorType; volume?: number; slideTo?: number; pan?: number };

function tone({ frequency, at = 0, duration, type = 'sine', volume = 0.2, slideTo, pan = 0 }: Tone): void {
  const ctx = audio();
  if (!ctx) return;
  const start = ctx.currentTime + at;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (slideTo !== undefined) oscillator.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  // Left (-1) to right (1). The column of a cell comes from its side on headphones.
  const panner = ctx.createStereoPanner();
  panner.pan.setValueAtTime(pan, start);
  oscillator.connect(gain).connect(panner).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

// Every cell has its own motif, so a player can follow the game by sound only:
// three quick rising notes for the layer, the row and the column, in a low, middle and high register.
// In each register, positions 1 to 4 are the steps C, D, E and G of the C major pentatonic scale, so
// every motif sounds good and a player learns one pattern. The column also comes from the side
// (left to right) on headphones. Example: layer 2, row 1, column 4 is D4, C5, G6, heard on the right.
const STEPS = [1, 9 / 8, 5 / 4, 3 / 2] as const; // C, D, E, G above a C
const REGISTERS = [261.63, 523.25, 1046.5] as const; // C4 for the layer, C5 for the row, C6 for the column
const PANS = [-0.75, -0.25, 0.25, 0.75] as const;

export type Motif = { notes: readonly [number, number, number]; pan: number };

export function cellMotif(cell: number): Motif {
  const { layer, row, column } = toCoords(cell);
  const step = (position: number, register: number) => {
    const ratio = STEPS[position as 0 | 1 | 2 | 3];
    const base = REGISTERS[register as 0 | 1 | 2];
    return base * ratio;
  };
  return { notes: [step(layer, 0), step(row, 1), step(column, 2)], pan: PANS[column as 0 | 1 | 2 | 3] };
}

const NOTE_GAP = 0.09;

// X sounds bright (triangle), O sounds round (sine), so the motif also tells whose move it was.
// A preview, before a move, is soft and neutral.
function playMotif(cell: number, voice: OscillatorType, volume: number): void {
  const { notes, pan } = cellMotif(cell);
  // Higher notes sound louder at the same level, so each register is a little softer than the last.
  notes.forEach((frequency, i) => tone({ frequency, at: i * NOTE_GAP, duration: 0.16, type: voice, volume: volume * (1 - i * 0.2), pan }));
}

export const sounds = {
  place(player: Player, cell: number): void {
    playMotif(cell, player === 'X' ? 'triangle' : 'sine', player === 'X' ? 0.22 : 0.3);
  },
  // The motif of a cell before it is played, for example from the keypad.
  preview(cell: number): void {
    playMotif(cell, 'sine', 0.14);
  },
  invalid(): void {
    tone({ frequency: 180, duration: 0.12, type: 'square', volume: 0.06 });
    tone({ frequency: 140, at: 0.11, duration: 0.16, type: 'square', volume: 0.06 });
  },
  // A chat message from the other player: a bright two-note ding.
  message(): void {
    tone({ frequency: 987.77, duration: 0.12, type: 'triangle', volume: 0.16 });
    tone({ frequency: 1318.51, at: 0.1, duration: 0.22, type: 'triangle', volume: 0.16 });
    tone({ frequency: 2637, at: 0.1, duration: 0.1, volume: 0.03 });
  },
  // Your chat message left: a short upward whoosh.
  sent(): void {
    tone({ frequency: 520, duration: 0.14, volume: 0.09, slideTo: 1240 });
  },
  // A clock tick in the last 10 seconds. The last 3 seconds sound higher.
  tick(urgent: boolean): void {
    tone({ frequency: urgent ? 1400 : 900, duration: 0.05, type: 'square', volume: 0.04 });
  },
  click(): void {
    tone({ frequency: 1200, duration: 0.04, volume: 0.05 });
  },
  win(): void {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((frequency, i) =>
      tone({ frequency, at: i * 0.09, duration: 0.35, type: 'triangle', volume: 0.2 }),
    );
  },
  lose(): void {
    [392, 349.23, 311.13, 261.63].forEach((frequency, i) =>
      tone({ frequency, at: i * 0.16, duration: 0.3, type: 'sawtooth', volume: 0.06 }),
    );
  },
  draw(): void {
    tone({ frequency: 440, duration: 0.25, type: 'triangle' });
    tone({ frequency: 440, at: 0.22, duration: 0.35, type: 'triangle', slideTo: 415 });
  },
};
