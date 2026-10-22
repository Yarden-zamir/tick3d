// A countdown to an end time. It reads the clock on each tick, not a counter: a browser delays the timers
// of a background tab, and the countdown must still end at the real end time.
const TICK_MS = 1000;

export type Countdown = {
  // Reads the clock now, for example when the tab comes back to the front.
  check(): void;
  stop(): void;
};

// Calls `tick` with the time left at once and then each second, and calls `end` one time when the end time passes.
export function countdown(endsAt: number, tick: (leftMs: number) => void, end: () => void): Countdown {
  let running = true;
  const timer = setInterval(() => check(), TICK_MS);
  const stop = () => {
    running = false;
    clearInterval(timer);
  };
  function check(): void {
    if (!running) return;
    const left = endsAt - Date.now();
    if (left > 0) {
      tick(left);
      return;
    }
    stop();
    end();
  }
  check();
  return { check, stop };
}

// "1:59": minutes and seconds, rounded up, so the display shows 0:00 only at the end.
export function formatLeft(leftMs: number): string {
  const seconds = Math.max(0, Math.ceil(leftMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
