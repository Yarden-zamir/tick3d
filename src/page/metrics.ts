// What the page records about each game for the stats page (Metrics in src/protocol.ts), and the
// fault reports. Nothing here holds a name, a chat message or an address.
import { detectDevice } from '../nearby/device.ts';
import { api } from '../online.ts';
import { type ClientEvent, type Code, MAX_COUNT, MAX_THINK_MS, type Metrics, type Refusal, toVersion } from '../protocol.ts';
import { computerTuning } from './advanced.ts';
import { settings } from './settings.ts';
import { page } from './state.ts';

// The page script file name carries the build hash, for example "index-B2x9kQ". In development it is the module name.
const APP_VERSION = toVersion(new URL(import.meta.url).pathname.split('/').at(-1)?.split('.')[0] ?? '');

const thisDevice = detectDevice();

type Counters = { key: string; input: Metrics['input']; refused: Metrics['refused']; undos: number; offline: boolean };
const fresh = (key: string): Counters => ({ key, input: { board: 0, keypad: 0 }, refused: {}, undos: 0, offline: false });

// The counts of the live game only. A switch to another game starts new counts, so a return to an
// earlier session counts from zero again. Revisit this if the stats page shows too few refusals.
let counters = fresh('');
const keyOf = (code: Code | undefined, index: number) => `${code ?? ''}:${index}`;

function live(): Counters {
  const key = keyOf(page.session?.code, page.games.length - 1);
  if (counters.key !== key) counters = fresh(key);
  if (!navigator.onLine) counters.offline = true;
  return counters;
}

export function countMove(via: keyof Metrics['input']): void {
  live().input[via]++;
}

export function countUndo(): void {
  live().undos++;
}

// A burst of refusals in a short time can mean a confusing screen, so it goes to the failures list.
const BURST_COUNT = 5;
const BURST_MS = 10_000;
let recentRefusals: number[] = [];

export function countRefusal(reason: Refusal): void {
  const counts = live().refused;
  counts[reason] = (counts[reason] ?? 0) + 1;
  const now = Date.now();
  recentRefusals = [...recentRefusals.filter((time) => now - time < BURST_MS), now];
  if (recentRefusals.length < BURST_COUNT) return;
  recentRefusals = [];
  report('refusals', `${BURST_COUNT} refusals in ${BURST_MS / 1000} s, the last one: ${reason}`);
}

// The metrics of a game that just ended. The caller adds the Nearby part, which needs a wait.
export function gameMetrics(code: Code, index: number, tuned: boolean): Metrics {
  const counted = counters.key === keyOf(code, index) ? counters : fresh('');
  // The server refuses a whole result with a value out of range, so cap each value here.
  const cap = (count: number) => Math.min(count, MAX_COUNT);
  const refused = Object.fromEntries(Object.entries(counted.refused).map(([reason, count]) => [reason, cap(count)]));
  return {
    device: thisDevice,
    view: settings.view,
    layout: settings.layout,
    theme: settings.theme,
    input: { board: cap(counted.input.board), keypad: cap(counted.input.keypad) },
    refused,
    undos: cap(counted.undos),
    // A tab in the background can stretch a search far past its budget.
    thinkMs: page.computerThinkMs.slice(0, 64).map((ms) => Math.min(ms, MAX_THINK_MS)),
    offline: counted.offline || !navigator.onLine,
    version: APP_VERSION,
    tuning: tuned ? computerTuning() : null,
    nearby: null,
  };
}

// At most this many reports per page load, so a fault in a loop sends only a few.
const MAX_REPORTS = 10;
let reports = 0;

function report(kind: ClientEvent['kind'], message: string): void {
  if (reports >= MAX_REPORTS || !navigator.onLine) return;
  reports++;
  // A failed report is dropped: a report must never cause another fault.
  void api.event({ kind, message: message.slice(0, 300) || 'No message', version: APP_VERSION }).catch(() => undefined);
}

const describe = (reason: unknown) => (reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));

export function setupReports(): void {
  addEventListener('error', (event) => {
    // Only the file name: a full address can carry a game code.
    const file = event.filename.split('/').at(-1)?.split('?')[0] ?? '';
    report('error', `${event.message} (${file}:${event.lineno})`);
  });
  addEventListener('unhandledrejection', (event) => report('rejection', describe(event.reason)));
}
