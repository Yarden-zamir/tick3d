// The voice engine: the one way for a page to play by voice. It opens the microphone, finds the pitch of
// each frame, places it in the player's range, and holds the lit cell against a wobble. Each frame goes to
// the subscribers as a VoiceFrame. The Voice room (/sound-input) and the game use it.
//
// Use:
//   const voice = createVoice();
//   const off = voice.subscribe((frame) => { if (frame.cell !== null) light(frame.cell); });
//   button.onclick = async () => { const problem = await voice.start(); if (problem !== null) show(problem); };
//   voice.pause() before the page plays its own sound, voice.resume() after it.
//   const clip = voice.clip(1000); // the last second of the microphone, for a replay: { samples, sampleRate }
// Draw the range with rail.ts (buildRail, showRailRange, showRailPitch, showRailTarget).
// The settings (range and stickiness) live in settings.ts. A page changes them with voice.saveSettings.
import { DEFAULT_RANGE, type PitchMap, type Range, cellOfStep, noteName } from './mapping.ts';
import { type Clip, type Microphone, levelShare, micError, openMicrophone } from './microphone.ts';
import { type VoiceSettings, loadVoiceSettings, saveVoiceSettings } from './settings.ts';
import type { Held, Stickiness } from './sticky.ts';
import { createTracker } from './tracker.ts';

// One frame of the voice. When no clear pitch holds a cell, `cell`, `held`, `frequency`, `note` and
// `position` are null, and `heldMs` and `margin` are 0.
export type VoiceFrame = {
  // Frame time (performance.now), and the time since the frame before (at most 100 ms).
  now: number;
  elapsed: number;
  // The input level for a meter, from 0 to 1 (-60 dB to 0 dB).
  level: number;
  // The pitch of this frame alone, before smoothing. Calibration uses it.
  raw: number | null;
  // The smoothed pitch, its note name ("G5 +12¢") and its place in the range (0 to 64).
  frequency: number | null;
  note: string | null;
  position: number | null;
  // The lit cell (cell index of src/game.ts), the held step, how long it holds, and its sticky margin in steps.
  cell: number | null;
  held: Held | null;
  heldMs: number;
  margin: number;
};

export type Voice = {
  // Opens the microphone. Call it from a tap. Returns null when the microphone listens, or a message for
  // the player when it does not (blocked, missing, busy).
  start(): Promise<string | null>;
  stop(): void;
  isListening(): boolean;
  // While paused, the engine drops the input and sends empty frames. Use it while the page plays a sound.
  pause(): void;
  resume(): void;
  // Calls `listener` with each frame while the microphone listens. Returns the function that ends it.
  subscribe(listener: (frame: VoiceFrame) => void): () => void;
  // Calls `listener` when the microphone stops by itself (unplugged, or taken by another app).
  onStop(listener: (message: string) => void): () => void;
  settings(): VoiceSettings;
  // Stores the settings on the device and uses them from the next frame.
  saveSettings(next: VoiceSettings): void;
  // The range in use: the calibrated range, else DEFAULT_RANGE.
  range(): Range;
  // The range and the spread in use: give it to the functions of mapping.ts and rail.ts.
  pitchMap(): PitchMap;
  // A copy of the last `ms` of the raw microphone audio, for a replay (for example the voice in the song of a
  // game). The engine keeps the last 3 s while it listens, so a longer `ms` gives at most 3 s, and a clip
  // right after start() gives less. Audio while paused is not in it. null when the microphone does not
  // listen. A clip in a subscriber holds the audio up to that frame. The audio stays in memory on the device:
  // the engine never sends or stores it.
  clip(ms: number): Clip | null;
  // A stickiness for this page only (for example none on a hard level), or null for the stored one.
  overrideStickiness(stickiness: Stickiness | null): void;
};

const EMPTY = { raw: null, frequency: null, note: null, position: null, cell: null, held: null, heldMs: 0, margin: 0 } as const;

export function createVoice(): Voice {
  let settings = loadVoiceSettings();
  let override: Stickiness | null = null;
  let mic: Microphone | undefined;
  let starting = false;
  let paused = false;
  const tracker = createTracker();
  // The pitch part of the last frame with a pitch, until the light goes out.
  let last: { frequency: number; note: string; position: number; cell: number; held: Held; margin: number } | undefined;
  const listeners = new Set<(frame: VoiceFrame) => void>();
  const stopListeners = new Set<(message: string) => void>();
  const range = () => settings.range ?? DEFAULT_RANGE;
  const pitchMap = (): PitchMap => ({ range: range(), spread: settings.spread });

  const emit = (frame: VoiceFrame) => {
    for (const listener of listeners) listener(frame);
  };

  const stop = () => {
    mic?.stop();
    mic = undefined;
    tracker.reset();
    last = undefined;
  };

  return {
    async start() {
      if (mic !== undefined || starting) return null;
      starting = true;
      try {
        mic = await openMicrophone(
          ({ now, elapsed, level, pitch }) => {
            const base = { now, elapsed, level: levelShare(level) };
            if (paused) return emit({ ...base, ...EMPTY });
            const raw = pitch?.frequency ?? null;
            const tracked = tracker.feed(raw, now, pitchMap(), override ?? settings.stickiness);
            if (tracked.kind === 'silent') last = undefined;
            if (tracked.kind === 'pitch') {
              last = {
                frequency: tracked.frequency,
                note: noteName(tracked.frequency),
                position: tracked.position,
                cell: cellOfStep(tracked.held.step),
                held: tracked.held,
                margin: tracked.margin,
              };
            }
            // A short gap (a breath, a click) keeps the cell of the frame before.
            if (last === undefined) return emit({ ...base, ...EMPTY, raw });
            emit({ ...base, ...last, raw, heldMs: now - last.held.since });
          },
          () => {
            stop();
            for (const listener of stopListeners) listener('The microphone stopped. Turn it on again to go on.');
          },
        );
        mic.record(!paused);
        // The page went out of view while the browser asked.
        if (document.hidden) {
          stop();
          return 'The microphone stops when the page is out of view. Turn it on again to go on.';
        }
        return null;
      } catch (error) {
        return micError(error);
      } finally {
        starting = false;
      }
    },
    stop,
    isListening: () => mic !== undefined,
    pause() {
      paused = true;
      mic?.record(false);
      tracker.reset();
      last = undefined;
    },
    resume() {
      paused = false;
      mic?.record(true);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStop(listener) {
      stopListeners.add(listener);
      return () => stopListeners.delete(listener);
    },
    settings: () => settings,
    saveSettings(next) {
      settings = next;
      saveVoiceSettings(next);
      tracker.reset();
      last = undefined;
    },
    range,
    pitchMap,
    clip: (ms) => mic?.clip(ms) ?? null,
    overrideStickiness(stickiness) {
      override = stickiness;
      tracker.reset();
      last = undefined;
    },
  };
}
