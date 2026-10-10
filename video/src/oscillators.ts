// A test helper: the pitches that a sound plays, read from a fake audio context. The soundtrack tests use it.
import { type ScheduledSound, scheduleNotes } from '../../src/sound.ts';

// Schedules one sound into a fake audio context, and returns the pitches of every oscillator that the sound
// starts: the value set at the start, then the target of a glide. A vibrato LFO is an oscillator too, far below
// 30 Hz, and it is left out.
export function oscillatorPitches(sound: ScheduledSound): number[][] {
  const pitches: number[][] = [];
  const param = () => ({ setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined });
  const node = (extra: object = {}): object => ({ ...extra, connect: (to: unknown) => to });
  const ctx = {
    currentTime: 0,
    sampleRate: 44_100,
    destination: {},
    createBuffer: () => ({ getChannelData: () => new Float32Array(44_100) }),
    createBufferSource: () => node({ start: () => undefined, stop: () => undefined }),
    createGain: () => node({ gain: param() }),
    createDynamicsCompressor: () => node({ threshold: param(), ratio: param(), attack: param(), release: param() }),
    createStereoPanner: () => node({ pan: param() }),
    createBiquadFilter: () => node({ frequency: param(), Q: param() }),
    createOscillator: () => {
      const own: number[] = [];
      pitches.push(own);
      const record = (value: number) => own.push(value);
      return node({ frequency: { setValueAtTime: record, exponentialRampToValueAtTime: record }, start: () => undefined, stop: () => undefined });
    },
  };
  scheduleNotes([{ ...sound, at: 0 }], ctx as unknown as BaseAudioContext);
  return pitches.filter((own) => own.every((hz) => hz >= 30));
}
