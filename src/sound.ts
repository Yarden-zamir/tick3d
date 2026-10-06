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

// Every cell has its own single sound, so a player can follow the game by ear. One strike carries all three
// coordinates at once:
// - the layer is the pitch: C, D, E or G of the C major pentatonic scale, higher layers higher;
// - the row is the instrument: 1 wooden marimba, 2 glass bell, 3 plucked string, 4 airy whistle;
// - the column is the width: 1 one voice, 2 with a fifth, 3 with an octave, 4 with both, and on
//   headphones it also comes from the left (1) to the right (4). The width works on a mono speaker too.
// O sounds one octave below X, so the strike also tells whose move it was.
const LAYER_NOTES = [523.25, 587.33, 659.25, 783.99] as const; // C5, D5, E5, G5
const INSTRUMENTS = ['marimba', 'bell', 'pluck', 'whistle'] as const;
const WIDTHS = [[1], [1, 3 / 2], [1, 2], [1, 3 / 2, 2]] as const;
const PANS = [-0.75, -0.25, 0.25, 0.75] as const;

export type Instrument = (typeof INSTRUMENTS)[number];
export type CellSound = { frequency: number; instrument: Instrument; intervals: readonly number[]; pan: number };

export function cellSound(cell: number): CellSound {
  const { layer, row, column } = toCoords(cell);
  const frequency = LAYER_NOTES[layer as 0 | 1 | 2 | 3];
  const instrument = INSTRUMENTS[row as 0 | 1 | 2 | 3];
  return { frequency, instrument, intervals: WIDTHS[column as 0 | 1 | 2 | 3], pan: PANS[column as 0 | 1 | 2 | 3] };
}

// One voice of an instrument at `frequency`, into `out`. Each instrument has its own partials and envelope.
function voice(ctx: AudioContext, out: AudioNode, instrument: Instrument, frequency: number, volume: number): void {
  const start = ctx.currentTime;
  const partial = (ratio: number, level: number, decay: number, type: OscillatorType = 'sine', attack = 0.005, to: AudioNode = out): OscillatorNode => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency * ratio, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume * level, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    oscillator.connect(gain).connect(to);
    oscillator.start(start);
    oscillator.stop(start + decay + 0.02);
    return oscillator;
  };
  switch (instrument) {
    case 'marimba':
      // A short wooden knock: the note and its fourth harmonic, both gone fast.
      partial(1, 1, 0.35);
      partial(4, 0.3, 0.08);
      return;
    case 'bell':
      // Glass: partials that are not whole multiples ring on after the strike.
      partial(1, 0.8, 0.9);
      partial(2.76, 0.45, 0.6);
      partial(5.4, 0.2, 0.3);
      return;
    case 'pluck': {
      // A string: a bright sawtooth whose filter closes fast, like a plucked string loses its edge.
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(frequency * 8, start);
      filter.frequency.exponentialRampToValueAtTime(frequency * 1.2, start + 0.3);
      filter.connect(out);
      partial(1, 0.7, 0.45, 'sawtooth', 0.004, filter);
      return;
    }
    case 'whistle': {
      // Air: a soft attack and a gentle vibrato.
      const tone = partial(1, 0.9, 0.5, 'sine', 0.06);
      partial(2, 0.08, 0.4, 'triangle', 0.06);
      const vibrato = ctx.createOscillator();
      const depth = ctx.createGain();
      vibrato.frequency.setValueAtTime(5.5, start);
      depth.gain.setValueAtTime(frequency * 0.006, start);
      vibrato.connect(depth).connect(tone.frequency);
      vibrato.start(start);
      vibrato.stop(start + 0.52);
      return;
    }
  }
}

function strike(cell: number, octave: number, volume: number): void {
  const ctx = audio();
  if (!ctx) return;
  const { frequency, instrument, intervals, pan } = cellSound(cell);
  const panner = ctx.createStereoPanner();
  panner.pan.setValueAtTime(pan, ctx.currentTime);
  panner.connect(ctx.destination);
  // More voices at the same level sound louder, so each voice gets a share.
  const share = volume / Math.sqrt(intervals.length);
  for (const interval of intervals) voice(ctx, panner, instrument, frequency * octave * interval, share);
}

export const sounds = {
  place(player: Player, cell: number): void {
    strike(cell, player === 'X' ? 1 : 1 / 2, 0.28);
  },
  // The sound of a cell before it is played, for example from the keypad: the same strike, softer.
  preview(cell: number): void {
    strike(cell, 1, 0.12);
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
