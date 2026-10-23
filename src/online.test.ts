import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, parseMyGames } from './online.ts';
import { normalizeCode } from './protocol.ts';

// A stand-in for the browser EventSource. The test opens, fails and closes each stream by hand.
class FakeSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static opened: FakeSource[] = [];
  readyState = FakeSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSource.opened.push(this);
  }
  open(): void {
    this.readyState = FakeSource.OPEN;
    this.onopen?.();
  }
  // The browser tries again by itself: the stream stays in CONNECTING.
  drop(): void {
    this.readyState = FakeSource.CONNECTING;
    this.onerror?.();
  }
  // An error status, such as a 502 of the proxy: the browser stops for good.
  fail(): void {
    this.readyState = FakeSource.CLOSED;
    this.onerror?.();
  }
  close(): void {
    this.readyState = FakeSource.CLOSED;
  }
}

const code = normalizeCode('AB23');
if (code === undefined) throw new Error('bad test code');

const last = (): FakeSource => {
  const source = FakeSource.opened.at(-1);
  if (source === undefined) throw new Error('no stream opened');
  return source;
};

describe('api.subscribe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSource.opened = [];
    vi.stubGlobal('EventSource', FakeSource);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads the session on each open and each change', () => {
    const onChange = vi.fn();
    api.subscribe(code, onChange);
    expect(last().url).toContain(`/api/sessions/${code}/events?player=`);
    last().open();
    last().onmessage?.();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('leaves a dropped stream to the browser', () => {
    api.subscribe(code, () => undefined);
    last().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.opened).toHaveLength(1);
  });

  // A deploy replaces the server: the proxy answers 502 until the new server runs.
  it('opens a new stream after an error status, with a longer wait after each failure', () => {
    const onChange = vi.fn();
    api.subscribe(code, onChange);
    last().fail();
    vi.advanceTimersByTime(999);
    expect(FakeSource.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSource.opened).toHaveLength(2);
    last().fail();
    vi.advanceTimersByTime(1999);
    expect(FakeSource.opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSource.opened).toHaveLength(3);
    // The server is back: the page loads the session, and the next failure waits 1 s again.
    last().open();
    expect(onChange).toHaveBeenCalledTimes(1);
    last().fail();
    vi.advanceTimersByTime(1000);
    expect(FakeSource.opened).toHaveLength(4);
  });

  it('waits at most 15 s between tries', () => {
    api.subscribe(code, () => undefined);
    for (let i = 0; i < 10; i++) {
      last().fail();
      vi.advanceTimersByTime(15_000);
    }
    expect(FakeSource.opened).toHaveLength(11);
  });

  it('opens no stream after the page leaves the session', () => {
    const unsubscribe = api.subscribe(code, () => undefined);
    last().fail();
    unsubscribe();
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.opened).toHaveLength(1);
  });

  it('opens no stream when the closed stream reports its error after the page left', () => {
    const unsubscribe = api.subscribe(code, () => undefined);
    const first = last();
    unsubscribe();
    first.fail();
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.opened).toHaveLength(1);
  });
});

describe('parseMyGames', () => {
  const avatar = 'https://avatars.githubusercontent.com/u/7?v=4';
  const answer = (opponent: unknown) => ({ user: null, total: {}, byMode: {}, byDifficulty: {}, sessions: [{ code: 'AB3K', opponent }] });

  it('fills the provider, name and seed that an older server leaves out, so a picture never draws from a missing seed', () => {
    expect(parseMyGames(answer({ login: 'octo', avatar })).sessions[0]?.opponent).toEqual({ provider: 'github', login: 'octo', avatar, name: null, seed: null });
  });

  it('refuses an account with a picture from another host', () => {
    expect(() => parseMyGames(answer({ login: 'octo', avatar: 'https://evil.example.org/a.png' }))).toThrow();
  });
});
