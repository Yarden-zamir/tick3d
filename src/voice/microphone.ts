// The microphone of the voice engine (engine.ts): it reads the input once per frame
// and finds its pitch (pitch.ts). The engine decides what to do with each frame.
import { type Pitch, bufferSize, detectPitch, rms } from './pitch.ts';

// `elapsed` is the time since the frame before, at most MAX_FRAME_MS. `level` is the RMS of the input.
export type Frame = { now: number; elapsed: number; level: number; pitch: Pitch | null };
export type Microphone = { stop(): void };

// A longer gap between two frames (a slow device) counts as this much, so one gap does not end a step.
const MAX_FRAME_MS = 100;

const hasMicrophone = (): boolean => 'mediaDevices' in navigator && typeof navigator.mediaDevices.getUserMedia === 'function';

export function micError(error: unknown): string {
  if (!hasMicrophone()) return 'This browser gives the page no microphone. Open the page over https in a current browser.';
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'The microphone is blocked. Allow it for this site in the browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Connect one, then try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone does not start. Another app can hold it. Close that app, then try again.';
    default:
      return `The microphone does not start: ${error instanceof Error ? error.message : 'unknown error'}.`;
  }
}

// Opens the microphone and calls `onFrame` once per animation frame until stop(). Call it from a tap:
// some browsers start an audio context without a tap as suspended. Throws the error of getUserMedia
// (micError turns it into a message). `onEnded` runs when the device stops by itself (unplugged).
export async function openMicrophone(onFrame: (frame: Frame) => void, onEnded: () => void): Promise<Microphone> {
  if (!hasMicrophone()) throw new Error('no microphone in this browser');
  const context = new AudioContext();
  let stream: MediaStream;
  try {
    // No processing: echo cancellation and noise suppression treat a steady whistle as noise.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (error) {
    void context.close();
    throw error;
  }
  const analyser = context.createAnalyser();
  analyser.fftSize = bufferSize(context.sampleRate);
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  let last: number | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      if (stopped) return;
      stop();
      onEnded();
    });
  }
  const read = (now: number) => {
    if (stopped) return;
    const elapsed = last === undefined ? 0 : Math.min(MAX_FRAME_MS, now - last);
    last = now;
    analyser.getFloatTimeDomainData(samples);
    onFrame({ now, elapsed, level: rms(samples), pitch: detectPitch(samples, context.sampleRate) });
    frame = requestAnimationFrame(read);
  };
  frame = requestAnimationFrame(read);
  return { stop };
}

// The meter of the level: -60 dB to 0 dB below full scale, as a share from 0 to 1.
export const levelShare = (level: number): number => Math.max(0, Math.min(1, (20 * Math.log10(level) + 60) / 60));
