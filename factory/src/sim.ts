// The factory clock. One in-game minute passes every 0.1 s at 1×, so a day takes 2.4 minutes and the
// week's cron schedules (read from the workflows) fire on time: play-signing on Monday 05:41,
// play-feedback every day at 06:17. The clock starts on Monday 05:30, just before both.

import type { Entity } from '../scan/model.ts';

export const MINUTES_PER_SECOND = 10;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface Cron {
  workflow: Entity;
  expression: string;
  minute: number | null;
  hour: number | null;
  weekday: number | null;
}

export function parseCrons(workflows: Entity[]): Cron[] {
  const crons: Cron[] = [];
  for (const workflow of workflows) {
    const list = workflow.data?.crons;
    if (!Array.isArray(list)) continue;
    for (const expression of list) {
      const [minute = '*', hour = '*', , , weekday = '*'] = String(expression).split(/\s+/);
      const field = (value: string): number | null => (value === '*' ? null : Number(value));
      crons.push({ workflow, expression: String(expression), minute: field(minute), hour: field(hour), weekday: field(weekday) });
    }
  }
  return crons;
}

export class Clock {
  /** Minutes since Sunday 00:00 of week 0. */
  minutes = 1 * 24 * 60 + 5 * 60 + 30;

  get day(): string {
    return DAYS[Math.floor(this.minutes / 1440) % 7] ?? 'Sun';
  }

  get hours(): number {
    return (this.minutes % 1440) / 60;
  }

  get time(): string {
    const total = Math.floor(this.minutes % 1440);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  get stamp(): string {
    return `${this.day} ${this.time}`;
  }

  /** 0 at night, 1 at noon. */
  get daylight(): number {
    const h = this.hours;
    // Sunrise at 04:00 and sunset at 20:00. The clock starts at 05:30, in the early morning light.
    return Math.max(0, Math.sin(((h - 4) / 16) * Math.PI));
  }

  matches(cron: Cron, minute: number): boolean {
    const m = minute % 60;
    const h = Math.floor(minute / 60) % 24;
    const d = Math.floor(minute / 1440) % 7;
    return (cron.minute === null || cron.minute === m) && (cron.hour === null || cron.hour === h) && (cron.weekday === null || cron.weekday === d);
  }

  /** Advances the clock and returns the crons that fired on the way. */
  advance(seconds: number, crons: Cron[]): Cron[] {
    const before = Math.floor(this.minutes);
    this.minutes += seconds * MINUTES_PER_SECOND;
    const after = Math.floor(this.minutes);
    const fired: Cron[] = [];
    for (let minute = before + 1; minute <= after; minute += 1) for (const cron of crons) if (this.matches(cron, minute)) fired.push(cron);
    return fired;
  }

  next(crons: Cron[]): { cron: Cron; inMinutes: number } | null {
    const start = Math.floor(this.minutes) + 1;
    for (let minute = start; minute < start + 7 * 1440; minute += 1) for (const cron of crons) if (this.matches(cron, minute)) return { cron, inMinutes: minute - this.minutes };
    return null;
  }
}

// Simulated players: which routes they call, and how often. The weights follow how the page uses the
// API: an open game holds an event stream and fetches the session on every change.
const WEIGHTS: [RegExp, number][] = [
  [/^GET \/api\/sessions\/\{code\}$/, 10],
  [/^GET \/api\/sessions\/\{code\}\/events$/, 4],
  [/^POST \/api\/sessions\/\{code\}\/moves$/, 8],
  [/^POST \/api\/events$/, 4],
  [/^GET \/api\/nearby\/hosts$/, 3],
  [/^POST \/api\/results$/, 2],
  [/^GET \/api\/me/, 2],
  [/^POST \/api\/sessions$/, 2],
  [/^GET \/api\/stats$/, 2],
  [/^POST \/api\/sessions\/\{code\}\/(join|games|chat)$/, 2],
  [/^GET \/api\/(health|previews)$/, 1.5],
];

export function pickRoute(routes: Entity[]): Entity | undefined {
  const weighted = routes.map((route) => {
    const match = WEIGHTS.find(([pattern]) => pattern.test(route.label));
    return { route, weight: match ? match[1] : 0.25 };
  });
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of weighted) {
    roll -= item.weight;
    if (roll <= 0) return item.route;
  }
  return weighted[weighted.length - 1]?.route;
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randomCode = (length: number): string => Array.from({ length }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

/** The route path with sample values, such as /api/sessions/K7P2/moves. */
export function samplePath(path: string): string {
  return path
    .replace('{code}', randomCode(4))
    .replace('{id}', `${randomCode(4)}-${1 + Math.floor(Math.random() * 5)}`)
    .replace('{person}', randomCode(10).toLowerCase())
    .replace('{host}', randomCode(6).toLowerCase())
    .replace('{message}', String(1 + Math.floor(Math.random() * 40)))
    .replace('{login}', 'someone');
}

/** The documented success status of the route (ROUTES), and now and then the rate limit's 429. */
export function statusFor(route: Entity): number {
  if (Math.random() < 0.03) return 429;
  return typeof route.data?.status === 'number' ? route.data.status : 200;
}
