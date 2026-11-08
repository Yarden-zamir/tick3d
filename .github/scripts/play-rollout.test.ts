import { describe, expect, it } from 'vitest';
import { type Release, daysBefore, decide, healthOf, latestRate, releasesAfter, stagedRelease, targetFraction } from './play-rollout.ts';

const DAY = 24 * 3_600_000;
const staged: Release = { name: '1.2.0', versionCodes: ['42'], status: 'inProgress', userFraction: 0.05 };
const previous: Release = { name: '1.1.0', versionCodes: ['40'], status: 'completed' };

describe('the steps of the rollout', () => {
  it('raises the share by full days since the upload', () => {
    expect(targetFraction(0)).toBe(0.05);
    expect(targetFraction(DAY - 1)).toBe(0.05);
    expect(targetFraction(DAY)).toBe(0.2);
    expect(targetFraction(2 * DAY)).toBe(0.5);
    expect(targetFraction(30 * DAY)).toBe(1);
  });

  it('raises a healthy release, also without vitals data, and completes it on day 3', () => {
    expect(decide(staged, DAY, { kind: 'ok' })).toEqual({ action: 'raise', fraction: 0.2 });
    expect(decide(staged, DAY, { kind: 'none' })).toEqual({ action: 'raise', fraction: 0.2 });
    expect(decide({ ...staged, userFraction: 0.5 }, 3 * DAY, { kind: 'ok' })).toEqual({ action: 'complete' });
  });

  it('waits for the next day, and when vitals fail', () => {
    expect(decide(staged, DAY / 2, { kind: 'ok' }).action).toBe('none');
    expect(decide(staged, 2 * DAY, { kind: 'unknown' }).action).toBe('none');
  });

  it('halts a release with bad vitals, and leaves a halted release alone', () => {
    expect(decide(staged, DAY, { kind: 'bad', reason: 'crashes' })).toEqual({ action: 'halt', reason: 'crashes' });
    expect(decide({ ...staged, status: 'halted' }, 3 * DAY, { kind: 'ok' }).action).toBe('none');
  });
});

describe('the track', () => {
  it('finds the staged release and its highest version code', () => {
    expect(stagedRelease([previous, { ...staged, versionCodes: ['41', '42'] }])?.versionCode).toBe(42);
    expect(stagedRelease([previous])).toBeUndefined();
  });

  it('keeps the complete release while the new one rolls out, and replaces it at 100 %', () => {
    expect(releasesAfter([staged, previous], { action: 'raise', fraction: 0.2 })).toEqual([{ ...staged, userFraction: 0.2 }, previous]);
    expect(releasesAfter([staged, previous], { action: 'halt', reason: 'x' })).toEqual([{ ...staged, status: 'halted' }, previous]);
    expect(releasesAfter([staged, previous], { action: 'complete' })).toEqual([{ name: '1.2.0', versionCodes: ['42'], status: 'completed' }]);
    const halted: Release = { name: '1.1.5', versionCodes: ['41'], status: 'halted' };
    expect(releasesAfter([staged, halted, previous], { action: 'complete' })).toEqual([{ name: '1.2.0', versionCodes: ['42'], status: 'completed' }, halted]);
  });
});

describe('Android vitals', () => {
  const row = (code: string, value: string, day: number) => ({
    startTime: { year: 2026, month: 11, day },
    dimensions: [{ dimension: 'versionCode', int64Value: code }],
    metrics: [{ metric: 'm', decimalValue: { value } }],
  });

  it('reads the newest day of the version, whatever the order of the rows', () => {
    expect(latestRate([row('42', '0.002', 4), row('41', '0.9', 5), row('42', '0.001', 3)], 42, 'm')).toBe(0.002);
    expect(latestRate([row('41', '0.9', 5)], 42, 'm')).toBeUndefined();
  });

  it('skips a newer row without the metric, so it cannot hide a rate over the limit', () => {
    const empty = { startTime: { year: 2026, month: 11, day: 6 }, dimensions: [{ dimension: 'versionCode', int64Value: '42' }], metrics: [] };
    expect(latestRate([row('42', '0.05', 5), empty], 42, 'm')).toBe(0.05);
  });

  it('is bad over a threshold of Google, and has no data without rows', () => {
    expect(healthOf(0.005, 0.001)).toEqual({ kind: 'ok' });
    expect(healthOf(0.02, undefined).kind).toBe('bad');
    expect(healthOf(undefined, 0.006).kind).toBe('bad');
    expect(healthOf(undefined, undefined)).toEqual({ kind: 'none' });
  });

  it('counts days back across a month', () => {
    expect(daysBefore({ year: 2026, month: 3, day: 3, timeZone: { id: 'America/Los_Angeles' } }, 7)).toEqual({ year: 2026, month: 2, day: 24, timeZone: { id: 'America/Los_Angeles' } });
  });
});
