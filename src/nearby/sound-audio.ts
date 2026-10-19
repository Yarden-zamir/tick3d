// A sound transfer owns one short-lived context. In particular, WebKit may never settle resume()
// or advance a context's clock after an interruption, so neither a resume nor a transfer waits forever.
let active = 0;
export const pairingSoundActive = (): boolean => active > 0;

export type PairingAudio = {
  signal: AbortSignal;
  resume(): Promise<void>;
  start(): void;
  interrupt(reason: Error): void;
};

function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    pending.then((value) => {
      signal.removeEventListener('abort', aborted);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', aborted);
      reject(error);
    });
    if (signal.aborted) aborted();
  });
}

export async function withPairingAudio<T>(outer: AbortSignal, run: (context: AudioContext, audio: PairingAudio) => Promise<T>, timeoutMs = 60_000): Promise<T> {
  outer.throwIfAborted();
  if (typeof AudioContext === 'undefined') throw new Error('Sound pairing is not supported here. Scan the reply instead.');
  // Resume synchronously from the tap before any module loads. Pin the carrier to 48 kHz; Web Audio
  // resamples the hardware, avoiding this modem build's unreliable internal 44.1 kHz resampler.
  const context = new AudioContext({ sampleRate: 48000 });
  const controller = new AbortController();
  const signal = AbortSignal.any([outer, controller.signal]);
  let monitoring = false;
  let resuming = false;
  let finished = false;
  active++;
  const interrupt = (reason: Error) => controller.abort(reason);
  const checkState = () => {
    if (monitoring && !resuming && context.state !== 'running') interrupt(new Error('Sound was interrupted. Try again or scan the reply.'));
  };
  const timer = setTimeout(() => controller.abort(new DOMException('Sound transfer timed out.', 'TimeoutError')), timeoutMs);
  const stop = () => {
    if (finished) return;
    finished = true;
    active--;
    clearTimeout(timer);
    context.removeEventListener('statechange', checkState);
    void context.close().catch(() => undefined);
  };
  signal.addEventListener('abort', stop, { once: true });
  context.addEventListener('statechange', checkState);
  const resume = async () => {
    signal.throwIfAborted();
    resuming = true;
    const waiting = setTimeout(() => interrupt(new Error('Audio did not start. Try again or scan the reply.')), 5000);
    try {
      await untilAbort(context.resume(), signal);
      signal.throwIfAborted();
      if (context.state !== 'running') throw new Error('Audio did not start. Try again or scan the reply.');
    } finally {
      clearTimeout(waiting);
      resuming = false;
    }
  };
  const audio: PairingAudio = {
    signal,
    resume,
    interrupt,
    start() {
      signal.throwIfAborted();
      monitoring = true;
      checkState();
      signal.throwIfAborted();
    },
  };
  try {
    await resume();
    signal.throwIfAborted();
    return await untilAbort(run(context, audio), signal);
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
}
