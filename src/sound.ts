import type { Player } from './game.ts';
import { SOUND_SETS, type SoundSetId, type SoundSet, type Voice } from './sound-sets.ts';

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
  play([{ wave: type, frequency, at, attack: 0.01, decay: duration, level: volume, ...(slideTo === undefined ? {} : { slideTo }), pan }]);
}

let noiseBuffer: AudioBuffer | undefined;

// One second of white noise, made once. Drums, wind and rain filter it.
function noise(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer === undefined) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

// Plays the voices of src/sound-sets.ts. Each voice is a source, an envelope, an optional filter and a side.
// `scale` makes all levels softer or louder, and `delay` starts all voices later.
function play(voices: readonly Voice[], scale = 1, delay = 0): void {
  const ctx = audio();
  if (!ctx) return;
  for (const voice of voices) {
    if (!(voice.level > 0) || !(voice.decay > 0)) throw new RangeError(`a voice needs a level and a decay: ${JSON.stringify(voice)}`);
    const start = ctx.currentTime + delay + (voice.at ?? 0);
    const end = start + voice.decay + 0.02;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(voice.level * scale, start + (voice.attack ?? 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + voice.decay);
    let source: AudioScheduledSourceNode;
    if (voice.wave === 'noise') {
      const buffer = ctx.createBufferSource();
      buffer.buffer = noise(ctx);
      buffer.loop = true;
      source = buffer;
    } else {
      const oscillator = ctx.createOscillator();
      oscillator.type = voice.wave;
      oscillator.frequency.setValueAtTime(voice.frequency, start);
      if (voice.slideTo !== undefined) oscillator.frequency.exponentialRampToValueAtTime(voice.slideTo, start + (voice.slideTime ?? voice.decay));
      if (voice.vibrato !== undefined) {
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.setValueAtTime(voice.vibrato.rate, start);
        depth.gain.setValueAtTime(voice.frequency * voice.vibrato.depth, start);
        lfo.connect(depth).connect(oscillator.frequency);
        lfo.start(start);
        lfo.stop(end);
      }
      source = oscillator;
    }
    let out: AudioNode = source.connect(gain);
    if (voice.filter !== undefined) {
      const { type, frequency, to, time, q } = voice.filter;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.setValueAtTime(frequency, start);
      if (to !== undefined) filter.frequency.exponentialRampToValueAtTime(to, start + (time ?? voice.decay));
      if (q !== undefined) filter.Q.setValueAtTime(q, start);
      out = out.connect(filter);
    }
    // Left (-1) to right (1). The column of a cell comes from its side on headphones.
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(voice.pan ?? 0, start);
    out.connect(panner).connect(ctx.destination);
    source.start(start);
    source.stop(end);
  }
}

let soundSet: SoundSet = SOUND_SETS.cells;

export function setSoundSet(id: SoundSetId): void {
  soundSet = SOUND_SETS[id];
}

// The demo of a set: the main diagonal of the tower, X and O in turn, one layer after the other.
const DEMO_CELLS = [0, 21, 42, 63] as const;
const DEMO_GAP = 0.42;

export function playDemo(id: SoundSetId): void {
  DEMO_CELLS.forEach((cell, index) => play(SOUND_SETS[id].voices(cell, index % 2 === 0 ? 'X' : 'O'), 1, index * DEMO_GAP));
}

// One cell of a set, as a move of X: the sound when a player picks the set.
export function playSample(id: SoundSetId): void {
  play(SOUND_SETS[id].voices(DEMO_CELLS[1], 'X'));
}

// The preview plays softer than a move: 0.12 against 0.28 in the Cells set.
const PREVIEW_SCALE = 0.12 / 0.28;

export const sounds = {
  place(player: Player, cell: number): void {
    play(soundSet.voices(cell, player));
  },
  // The sound of a cell before it is played, for example from the keypad: the same strike, softer.
  preview(cell: number): void {
    play(soundSet.voices(cell, 'X'), PREVIEW_SCALE);
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
