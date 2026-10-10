// The beat grid of every video: the sixteenth notes of the 136 BPM song of src/song.ts, at 30 frames a second.
// Everything here is a function of the frame number, so every render gives the same video.
import { SIXTEENTH } from '../../src/song.ts';

export const FPS = 30;
// The length of one sixteenth note in frames: about 3.3.
export const S16_FRAMES = SIXTEENTH * FPS;

// The frame where sixteenth `s16` starts. Events and cuts land on these frames.
export const frameOf = (s16: number): number => Math.round(s16 * S16_FRAMES);

// The time since sixteenth `at`, in sixteenths: below 0 before it, 0 on its frame. Motion reads this, so
// a motion that starts on an event starts on the same frame as the event.
export const since = (frame: number, at: number): number => (frame - frameOf(at)) / S16_FRAMES;
