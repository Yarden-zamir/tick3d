// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The states of a live context in Safari: 'interrupted' is iOS only (a call, the lock screen, another app).
type State = 'suspended' | 'interrupted' | 'running' | 'closed';

const param = () => ({ setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined });
const node = <T extends object>(extra: T) => ({ connect: <N>(next: N) => next, ...extra });

// Counts what the sound module asks of the context: resumes, closes and started sounds.
class FakeContext {
  static made: FakeContext[] = [];
  static startState: State = 'suspended';
  state: State = FakeContext.startState;
  currentTime = 0;
  resumes = 0;
  started = 0;
  destination = {};
  constructor() {
    FakeContext.made.push(this);
  }
  resume() {
    this.resumes++;
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  createGain() {
    return node({ gain: param() });
  }
  createStereoPanner() {
    return node({ pan: param() });
  }
  createOscillator() {
    return node({ type: 'sine', frequency: param(), start: () => this.started++, stop: () => undefined });
  }
}

let gesture = false;
let now = 0;
// The page listeners of each loaded module, removed after each case: every case loads a fresh module.
const listeners: Array<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; capture: boolean }> = [];

async function loadSound() {
  const spies = [window, document].map((target) => {
    const add = target.addEventListener.bind(target);
    return vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener !== null) listeners.push({ target, type, listener, capture: typeof options === 'object' ? options.capture === true : options === true });
      add(type, listener, options);
    });
  });
  const module = await import('./sound.ts');
  for (const spy of spies) spy.mockRestore();
  return module;
}

const context = (index = 0): FakeContext => {
  const made = FakeContext.made[index];
  if (made === undefined) throw new Error(`no context ${index}`);
  return made;
};

const tap = () => window.dispatchEvent(new Event('pointerup'));

beforeEach(() => {
  vi.resetModules();
  FakeContext.made = [];
  FakeContext.startState = 'suspended';
  gesture = false;
  now = 0;
  vi.stubGlobal('AudioContext', FakeContext);
  Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => ({ isActive: gesture }) });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  for (const { target, type, listener, capture } of listeners.splice(0)) target.removeEventListener(type, listener, capture);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the live audio context', () => {
  for (const state of ['suspended', 'interrupted'] as const) {
    it(`skips a sound without a gesture when it is ${state}, and asks it to resume`, async () => {
      FakeContext.startState = state;
      const { sounds } = await loadSound();
      sounds.click();
      expect(context().started).toBe(0);
      expect(context().resumes).toBe(1);
    });

    it(`resumes it from ${state} and plays the sound of a gesture`, async () => {
      FakeContext.startState = state;
      const { sounds } = await loadSound();
      gesture = true;
      sounds.click();
      expect(context().started).toBeGreaterThan(0);
      expect(context().resumes).toBeGreaterThan(0);
    });
  }

  it('plays on a running context without a gesture, and does not resume it', async () => {
    FakeContext.startState = 'running';
    const { sounds } = await loadSound();
    sounds.click();
    expect(context().started).toBeGreaterThan(0);
    expect(context().resumes).toBe(0);
  });

  it('makes and resumes the context on the first tap, so the first sound can come from the other player', async () => {
    await loadSound();
    tap();
    expect(FakeContext.made).toHaveLength(1);
    expect(context().resumes).toBe(1);
  });

  it('resumes an interrupted context when the page comes back to the front', async () => {
    const { sounds } = await loadSound();
    sounds.click();
    context().state = 'interrupted';
    const resumes = context().resumes;
    window.dispatchEvent(new Event('pageshow'));
    expect(context().resumes).toBe(resumes + 1);
  });

  it('makes a new context on a tap when a running context has a stopped clock', async () => {
    FakeContext.startState = 'running';
    await loadSound();
    // The first tap makes the context, the second reads its clock.
    tap();
    tap();
    now = 2000;
    tap();
    expect(context(0).state).toBe('closed');
    expect(FakeContext.made).toHaveLength(2);
  });

  it('keeps a running context whose clock moves', async () => {
    FakeContext.startState = 'running';
    await loadSound();
    // The first tap makes the context, the second reads its clock.
    tap();
    tap();
    now = 2000;
    context().currentTime = 2;
    tap();
    expect(FakeContext.made).toHaveLength(1);
  });

  it('leaves the context alone while the sound is muted', async () => {
    const { setMuted, sounds } = await loadSound();
    setMuted(true);
    tap();
    sounds.click();
    expect(FakeContext.made).toHaveLength(0);
  });
});
