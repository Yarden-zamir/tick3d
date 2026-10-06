// The microphone for pitch detection, and the frame rules that /sound-input and play by voice share.
import { bufferSize } from './pitch.ts';

// The median of the last frames moves the light, so one odd frame (a click, an octave jump) does not.
export const SMOOTH_FRAMES = 5;
// After this many frames without a clear pitch (about 0.1 s), the light goes out.
export const MISS_FRAMES = 6;
// A note on one cell for this long places a mark there.
export const HOLD_MS = 1000;

export type Mic = { stream: MediaStream; context: AudioContext; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer> };

// Browsers give no microphone to a page without https.
export const hasMic = (): boolean => 'mediaDevices' in navigator && typeof navigator.mediaDevices.getUserMedia === 'function';

// Opens the microphone, and rejects with the error of getUserMedia. Call it during a tap: the context
// starts in the call, and some browsers start a context without a tap as suspended.
export async function openMic(): Promise<Mic> {
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
  return { stream, context, analyser, samples: new Float32Array(analyser.fftSize) };
}

export function closeMic({ stream, context }: Mic): void {
  for (const track of stream.getTracks()) track.stop();
  void context.close();
}

export function micError(error: unknown): string {
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
