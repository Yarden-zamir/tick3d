import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countdown, formatLeft } from './countdown.ts';

describe('the countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('ticks each second and ends one time at the end time', () => {
    const tick = vi.fn();
    const end = vi.fn();
    countdown(3000, tick, end);
    expect(tick).toHaveBeenLastCalledWith(3000);
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenLastCalledWith(1000);
    expect(end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(end).toHaveBeenCalledOnce();
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('ends on a check after the clock jumped, as in a background tab with delayed timers', () => {
    const end = vi.fn();
    const wait = countdown(120_000, () => undefined, end);
    // The clock moves on, but no timer ran.
    vi.setSystemTime(130_000);
    wait.check();
    expect(end).toHaveBeenCalledOnce();
  });

  it('does nothing after stop', () => {
    const end = vi.fn();
    countdown(1000, () => undefined, end).stop();
    vi.advanceTimersByTime(5000);
    expect(end).not.toHaveBeenCalled();
  });
});

describe('the time left on screen', () => {
  it.each([
    [120_000, '2:00'],
    [119_001, '2:00'],
    [59_000, '0:59'],
    [1, '0:01'],
    [0, '0:00'],
    [-500, '0:00'],
  ])('%i ms shows %s', (left, text) => {
    expect(formatLeft(left)).toBe(text);
  });
});
