import { describe, expect, it } from 'vitest';
import { NO_PROGRESS, WAIT_MS, force, markDone, parseProgress, stepStates, waitLeft } from './steps.ts';

const NOW = 1_000_000;
const states = (progress = NO_PROGRESS, phone: 'android' | 'iphone' = 'android', now = NOW) => stepStates(progress, phone, now).map(({ state }) => state);

describe('the order of the steps', () => {
  it('opens only the first step on a first visit', () => {
    expect(states()).toEqual(['open', 'locked', 'locked', 'locked']);
    expect(states(NO_PROGRESS, 'iphone')).toEqual(['open', 'locked', 'locked']);
  });

  it('opens the next step when a step is done', () => {
    expect(states(markDone(NO_PROGRESS, 'group', NOW))).toEqual(['done', 'open', 'locked', 'locked']);
    expect(states(markDone(NO_PROGRESS, 'testflight', NOW), 'iphone')).toEqual(['done', 'open', 'locked']);
  });

  it('counts the steps before a done step as done', () => {
    expect(states(markDone(NO_PROGRESS, 'code', NOW))).toEqual(['done', 'done', 'done', 'open']);
  });

  it('opens a forced step at once, and keeps the steps after it locked', () => {
    expect(states(force(NO_PROGRESS, 'code'))).toEqual(['open', 'locked', 'open', 'locked']);
  });
});

describe('the wait after "Become a tester"', () => {
  const tester = markDone(markDone(NO_PROGRESS, 'group', NOW), 'tester', NOW);

  it('makes the code step wait, then opens it at the end time', () => {
    expect(states(tester)).toEqual(['done', 'done', 'waiting', 'locked']);
    expect(waitLeft(tester, NOW)).toBe(WAIT_MS);
    expect(states(tester, 'android', NOW + WAIT_MS - 1)[2]).toBe('waiting');
    expect(states(tester, 'android', NOW + WAIT_MS)[2]).toBe('open');
    expect(waitLeft(tester, NOW + WAIT_MS + 5000)).toBe(0);
  });

  it('keeps the first end time when the link is tapped again', () => {
    expect(markDone(tester, 'tester', NOW + 60_000).waitUntil).toBe(NOW + WAIT_MS);
  });

  it('opens early when forced', () => {
    expect(states(force(tester, 'code'))[2]).toBe('open');
  });

  it('does not make the code step wait before "Become a tester" is done', () => {
    expect(states(force(NO_PROGRESS, 'code'))[2]).toBe('open');
  });
});

describe('the progress that this browser keeps', () => {
  it('survives a round trip through JSON', () => {
    const progress = { ...force(markDone(NO_PROGRESS, 'tester', NOW), 'install'), remind: true };
    expect(parseProgress(JSON.parse(JSON.stringify(progress)))).toEqual(progress);
  });

  it('drops unknown steps and broken values', () => {
    expect(parseProgress({ done: ['group', 'nope', 'group', 3], forced: 'code', waitUntil: 'soon', remind: 'yes' })).toEqual({ ...NO_PROGRESS, done: ['group'] });
    expect(parseProgress(null)).toEqual(NO_PROGRESS);
    expect(parseProgress([])).toEqual(NO_PROGRESS);
  });
});
