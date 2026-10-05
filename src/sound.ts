import type { Player } from './game.ts';

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

type Tone = { frequency: number; at?: number; duration: number; type?: OscillatorType; volume?: number; slideTo?: number };

function tone({ frequency, at = 0, duration, type = 'sine', volume = 0.2, slideTo }: Tone): void {
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
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

// C major pentatonic: higher layers sound higher.
const LAYER_NOTES = [523.25, 587.33, 659.25, 783.99] as const;

export const sounds = {
  place(player: Player, layer: number): void {
    const note = LAYER_NOTES[layer as 0 | 1 | 2 | 3];
    tone({ frequency: player === 'X' ? note : note / 2, duration: 0.18, type: 'triangle', volume: 0.25 });
    tone({ frequency: note * 2, at: 0.02, duration: 0.08, volume: 0.06 });
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
