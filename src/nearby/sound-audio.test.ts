import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pairingSoundActive, withPairingAudio } from './sound-audio.ts';

const contexts: FakeContext[] = [];
const controllers: AbortController[] = [];
let resume: ((context: FakeContext) => Promise<void>) | undefined;

class FakeContext extends EventTarget {
  state: AudioContextState = 'suspended';
  resume = vi.fn(() => {
    if (resume !== undefined) return resume(this);
    this.setState('running');
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.setState('closed');
    return Promise.resolve();
  });
  constructor() {
    super();
    contexts.push(this);
  }
  setState(state: string): void {
    // WebKit also uses 'interrupted', which is absent from some DOM type versions.
    this.state = state as AudioContextState;
    this.dispatchEvent(new Event('statechange'));
  }
}

const controller = () => {
  const current = new AbortController();
  controllers.push(current);
  return current;
};

beforeEach(() => {
  resume = undefined;
  contexts.length = 0;
  controllers.length = 0;
  vi.stubGlobal('AudioContext', FakeContext);
});

afterEach(() => {
  for (const current of controllers) current.abort();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sound transfer audio lifecycle', () => {
  it('bounds a WebKit resume promise that never settles', async () => {
    vi.useFakeTimers();
    resume = () => new Promise(() => undefined);
    const run = vi.fn(async () => 'unused');
    const pending = withPairingAudio(controller().signal, run);
    const rejected = expect(pending).rejects.toThrow('Audio did not start');
    expect(pairingSoundActive()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(run).not.toHaveBeenCalled();
    expect(pairingSoundActive()).toBe(false);
    expect(contexts[0]?.close).toHaveBeenCalledOnce();
  });

  it.each(['interrupted', 'suspended', 'closed'])('fails fast when a started transfer becomes %s', async (state) => {
    const started = vi.fn();
    const pending = withPairingAudio(controller().signal, async (_context, audio) => {
      audio.start();
      started();
      return new Promise(() => undefined);
    });
    const rejected = expect(pending).rejects.toThrow('Sound was interrupted');
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    contexts[0]?.setState(state);
    await rejected;
    expect(pairingSoundActive()).toBe(false);
    expect(contexts[0]?.close).toHaveBeenCalledOnce();
  });

  it('bounds a running context whose clock or source end event stalls', async () => {
    vi.useFakeTimers();
    const pending = withPairingAudio(controller().signal, async (_context, audio) => {
      audio.start();
      return new Promise(() => undefined);
    }, 1000);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(pairingSoundActive()).toBe(false);
    expect(contexts[0]?.close).toHaveBeenCalledOnce();
  });

  it('resumes again after microphone capture interrupts the initially unlocked context', async () => {
    await expect(withPairingAudio(controller().signal, async (context, audio) => {
      contexts[0]?.setState('interrupted');
      if (context.state !== 'running') await audio.resume();
      audio.start();
      return context.state;
    })).resolves.toBe('running');
    expect(contexts[0]?.resume).toHaveBeenCalledTimes(2);
    expect(contexts[0]?.close).toHaveBeenCalledOnce();
    expect(pairingSoundActive()).toBe(false);
  });

  it('cancels even before a pending resume has settled', async () => {
    resume = () => new Promise(() => undefined);
    const current = controller();
    const pending = withPairingAudio(current.signal, async () => 'unused');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    current.abort();
    await rejected;
    expect(pairingSoundActive()).toBe(false);
    expect(contexts[0]?.close).toHaveBeenCalledOnce();
  });
});
