// Long polls: requests that wait for a change to a session. An API client without an event stream
// (for example an AI agent with curl) uses them instead of busy polling.
// They live in this process only, like the event streams. Revisit this with more than one API process.
import type { Code } from '../src/protocol.ts';

export function createWaiters(max: number) {
  if (!(Number.isInteger(max) && max >= 1)) throw new RangeError('waiters need a positive limit');
  const waiting = new Map<Code, Set<() => void>>();
  let count = 0;

  return {
    // Tells the waiters of a session to read its version again.
    wake(code: Code): void {
      for (const listener of waiting.get(code) ?? []) listener();
    },

    count: () => count,

    // Resolves when `version()` is greater than `since`, when `timeoutMs` passes, or when `signal` aborts.
    // Returns undefined when `max` requests wait already, so the caller can refuse the request.
    until(code: Code, since: number, version: () => Promise<number>, signal: AbortSignal, timeoutMs: number): Promise<void> | undefined {
      if (count >= max) return undefined;
      count++;
      const deadline = Date.now() + timeoutMs;
      // A wake during a version read sets `dirty`, so the loop reads again instead of sleeping past it.
      let dirty = false;
      let poke: () => void = () => {};
      const listener = () => {
        dirty = true;
        poke();
      };
      const set = waiting.get(code) ?? new Set();
      waiting.set(code, set);
      set.add(listener);
      signal.addEventListener('abort', listener);

      const run = async () => {
        while (!signal.aborted && Date.now() < deadline) {
          dirty = false;
          if ((await version()) > since) return;
          if (dirty) continue;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, deadline - Date.now());
            poke = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
      };
      return run().finally(() => {
        count--;
        set.delete(listener);
        if (set.size === 0) waiting.delete(code);
        signal.removeEventListener('abort', listener);
      });
    },
  };
}
