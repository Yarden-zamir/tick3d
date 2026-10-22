// The order of the steps on /share. A later step looks grayed out until the steps before it are done, so
// players do not skip one. A tap on a grayed step opens it at once ("forced"). The page keeps the progress.
import { isRecord, isUnknownArray } from '../guards.ts';
import type { Phone } from './phone.ts';

const STEP_IDS = ['group', 'tester', 'code', 'install', 'testflight', 'invite', 'keep'] as const;
export type StepId = (typeof STEP_IDS)[number];

// The steps of each path, in the order of share.html (data-step).
export const STEPS: Readonly<Record<Phone, readonly StepId[]>> = {
  android: ['group', 'tester', 'code', 'install'],
  iphone: ['testflight', 'invite', 'keep'],
};

// After "Become a tester", Google needs a few minutes before a code works. The next step waits this long.
const WAIT_AFTER: StepId = 'tester';
export const WAIT_MS = 2 * 60_000;

// `waitUntil` is the end time of the wait (epoch ms), or null before the wait starts.
// `remind` is true when the player asked for a notification at the end of the wait.
export type Progress = { done: StepId[]; forced: StepId[]; waitUntil: number | null; remind: boolean };

// done: the player did it. open: the step to do now. waiting: the wait before it runs. locked: an earlier step is not done.
export type StepState = 'done' | 'open' | 'waiting' | 'locked';

export const NO_PROGRESS: Progress = { done: [], forced: [], waitUntil: null, remind: false };

const isStepId = (value: unknown): value is StepId => STEP_IDS.some((id) => id === value);
const stepIds = (value: unknown): StepId[] => (isUnknownArray(value) ? [...new Set(value.filter(isStepId))] : []);

// The progress from storage. A broken value starts over.
export function parseProgress(value: unknown): Progress {
  if (!isRecord(value)) return NO_PROGRESS;
  const { waitUntil } = value;
  return {
    done: stepIds(value.done),
    forced: stepIds(value.forced),
    waitUntil: typeof waitUntil === 'number' && Number.isFinite(waitUntil) ? waitUntil : null,
    remind: value.remind === true,
  };
}

// The first done of WAIT_AFTER starts the wait. A second tap on its link keeps the first end time.
export function markDone(progress: Progress, step: StepId, now: number): Progress {
  const waitUntil = step === WAIT_AFTER && progress.waitUntil === null ? now + WAIT_MS : progress.waitUntil;
  return { ...progress, done: progress.done.includes(step) ? progress.done : [...progress.done, step], waitUntil };
}

export const force = (progress: Progress, step: StepId): Progress =>
  progress.forced.includes(step) ? progress : { ...progress, forced: [...progress.forced, step] };

// The time left of the wait, 0 when it ended or did not start.
export const waitLeft = (progress: Progress, now: number): number => (progress.waitUntil === null ? 0 : Math.max(0, progress.waitUntil - now));

// The state of each step of the path, in its order. A done step counts the steps before it as done too:
// a player with a claimed code joined the group already, for example.
export function stepStates(progress: Progress, phone: Phone, now: number): { step: StepId; state: StepState }[] {
  const steps = STEPS[phone];
  const lastDone = steps.findLastIndex((step) => progress.done.includes(step));
  return steps.map((step, index) => {
    if (index <= lastDone) return { step, state: 'done' };
    const forced = progress.forced.includes(step);
    // Every step up to `lastDone` is done, so the step right after it is the next one.
    if (index > lastDone + 1 && !forced) return { step, state: 'locked' };
    const waits = steps[index - 1] === WAIT_AFTER && index - 1 <= lastDone && waitLeft(progress, now) > 0 && !forced;
    return { step, state: waits ? 'waiting' : 'open' };
  });
}
