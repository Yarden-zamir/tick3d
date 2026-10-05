import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Code } from '../src/protocol.ts';
import { createWaiters } from './waiters.ts';

const code = 'AB3K' as Code;

afterEach(() => {
  vi.useRealTimers();
});

describe('createWaiters', () => {
  it('returns at once when the version is already newer', async () => {
    const waiters = createWaiters(10);
    await waiters.until(code, 1, () => Promise.resolve(2), new AbortController().signal, 25_000);
    expect(waiters.count()).toBe(0);
  });

  it('waits for a wake that brings a newer version', async () => {
    const waiters = createWaiters(10);
    let version = 1;
    let done = false;
    const wait = waiters.until(code, 1, () => Promise.resolve(version), new AbortController().signal, 25_000);
    void wait?.then(() => (done = true));
    await vi.waitFor(() => expect(waiters.count()).toBe(1));

    // A wake without a new version (a presence change) keeps the request waiting.
    waiters.wake(code);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);

    version = 2;
    waiters.wake(code);
    await wait;
    expect(waiters.count()).toBe(0);
  });

  it('ignores a wake for another session', async () => {
    vi.useFakeTimers();
    const waiters = createWaiters(10);
    const wait = waiters.until(code, 1, () => Promise.resolve(1), new AbortController().signal, 1000);
    waiters.wake('ZZZZ' as Code);
    await vi.advanceTimersByTimeAsync(999);
    expect(waiters.count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(waiters.count()).toBe(0);
  });

  it('does not miss a wake that comes during the version read', async () => {
    const waiters = createWaiters(10);
    let version = 1;
    let reads = 0;
    const wait = waiters.until(
      code,
      1,
      () => {
        reads++;
        // The first read sees version 1, and a change lands before the read returns.
        if (reads === 1) {
          version = 2;
          waiters.wake(code);
          return Promise.resolve(1);
        }
        return Promise.resolve(version);
      },
      new AbortController().signal,
      25_000,
    );
    await wait;
    expect(reads).toBe(2);
  });

  it('stops and cleans up when the client disconnects', async () => {
    const waiters = createWaiters(10);
    const controller = new AbortController();
    const wait = waiters.until(code, 1, () => Promise.resolve(1), controller.signal, 25_000);
    await vi.waitFor(() => expect(waiters.count()).toBe(1));
    controller.abort();
    await wait;
    expect(waiters.count()).toBe(0);
  });

  it('refuses a request over the limit, and frees the place after a wait ends', async () => {
    const waiters = createWaiters(1);
    const controller = new AbortController();
    const first = waiters.until(code, 1, () => Promise.resolve(1), controller.signal, 25_000);
    expect(waiters.until(code, 1, () => Promise.resolve(1), new AbortController().signal, 25_000)).toBeUndefined();
    controller.abort();
    await first;
    const again = waiters.until(code, 0, () => Promise.resolve(1), new AbortController().signal, 25_000);
    expect(again).toBeDefined();
    await again;
  });

  it('passes a failed version read to the caller and cleans up', async () => {
    const waiters = createWaiters(10);
    const wait = waiters.until(code, 1, () => Promise.reject(new Error('no game')), new AbortController().signal, 25_000);
    await expect(wait).rejects.toThrow('no game');
    expect(waiters.count()).toBe(0);
  });
});
