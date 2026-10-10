import { type AchievementProgress, parseAchievements } from './achievements.ts';
import type { TimeControl } from './clock.ts';
import { parseDeletedPeople } from './deletions.ts';
import type { EpochMs } from './epoch.ts';
import { type Announced, type HostId, type LobbyHost, parseAnnounced, parseLobbyHosts } from './nearby/lobby.ts';
import type { PlayoffRequest } from './practice/playoff.ts';
import { type PracticeBoard, type PracticeMode, type PracticeRun, type PresetId, parsePracticeBoard } from './practice/practice.ts';
import { type Records, parseRecords } from './records.ts';
import {
  type ClientEvent,
  type Code,
  type DeviceGameId,
  type GameId,
  type OnlineGameId,
  type HistoryPage,
  type Metrics,
  type MoveRequest,
  type MyGames,
  type PersonId,
  type PlayerInfo,
  type PlayerToken,
  type Previews,
  type ReportReason,
  type PublicGame,
  RESULTS_PER_UPLOAD,
  type ResultUpload,
  type SeatAction,
  type SessionUpdate,
  type SessionView,
  type StatsFilter,
  type StatsPrivacy,
  parseStatsPrivacy,
  asPlayerToken,
  parseBlocks,
  parseCustomName,
  parseDeviceGameId,
  parseHistoryPage,
  parsePlayerInfo,
  parsePreviews,
  parsePublicGame,
  parseSessionView,
  statsQuery,
} from './protocol.ts';
import { STORAGE_KEYS } from './storage-keys.ts';


// crypto.randomUUID exists only on HTTPS and localhost. A phone on the local network loads the dev
// server over plain HTTP, so fall back to random hex from getRandomValues, which works everywhere.
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function newToken(): PlayerToken {
  const token = asPlayerToken(randomId());
  if (token === undefined) throw new Error('randomId produced an invalid player token');
  return token;
}

// One token per browser. It survives reloads, so a player keeps the seat after a refresh.
function playerToken(): PlayerToken {
  try {
    const stored = asPlayerToken(localStorage.getItem(STORAGE_KEYS.player));
    if (stored !== undefined) return stored;
    const created = newToken();
    localStorage.setItem(STORAGE_KEYS.player, created);
    return created;
  } catch {
    // Storage is blocked. The seat then lasts for this page load only.
    return newToken();
  }
}

export const token = playerToken();

// A refused or failed server call. The message is fit to show to the player.
// `status` is the HTTP status of an error answer from the server. It is undefined when no usable
// answer arrived: the request did not reach the server, or a success answer had no JSON body.
export class OnlineError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const NOT_JSON = Symbol('not JSON');

async function call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-player': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new OnlineError('Cannot reach the server. Check the connection.');
  }
  const data: unknown = await response.json().catch(() => NOT_JSON);
  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Server error (${response.status}).`;
    throw new OnlineError(message, response.status);
  }
  // A proxy or a captive portal can answer 200 with an HTML page.
  if (data === NOT_JSON) throw new OnlineError('The server sent an answer that the game cannot read.');
  return data;
}

const request = async (method: string, path: string, body?: unknown): Promise<SessionView> =>
  parseSessionView(await call(method, `/sessions${path}`, body));

// `name` is the custom name of a player without a GitHub login, or null.
export type Me = { loginAvailable: boolean; user: PlayerInfo | null; name: string | null };

export function parseMe(value: unknown): Me {
  if (typeof value !== 'object' || value === null) throw new Error('invalid answer from /api/me');
  const { loginAvailable, user } = value as Record<string, unknown>;
  const info = user === null ? null : parsePlayerInfo(user);
  // An older server sends no name.
  const raw = (value as Record<string, unknown>).name;
  const name = raw === undefined || raw === null ? null : parseCustomName(raw);
  if (typeof loginAvailable !== 'boolean' || info === undefined || name === undefined || (raw !== undefined && raw !== null && raw !== name)) {
    throw new Error('invalid answer from /api/me');
  }
  return { loginAvailable, user: info, name };
}

// The page reads "My games" only to display it, so a light shape check is enough here.
export function parseMyGames(value: unknown): MyGames {
  if (typeof value !== 'object' || value === null || !('total' in value) || !('sessions' in value)) {
    throw new Error('invalid answer from /api/me/games');
  }
  return value as MyGames;
}

function requireStatsPrivacy(value: unknown): StatsPrivacy {
  const privacy = parseStatsPrivacy(value);
  if (privacy === undefined) throw new Error('invalid answer from /api/me/stats-privacy');
  return privacy;
}

export const api = {
  create: (name: string, clock: TimeControl) => request('POST', '', { name, clock }),
  load: (code: Code) => request('GET', `/${code}`),
  join: (code: Code) => request('POST', `/${code}/join`),
  move: (code: Code, move: MoveRequest) => request('POST', `/${code}/moves`, move),
  newGame: (code: Code) => request('POST', `/${code}/games`),
  update: (code: Code, changes: SessionUpdate) => request('PATCH', `/${code}`, changes),
  lock: (code: Code) => request('POST', `/${code}/lock`),
  chat: (code: Code, text: string) => request('POST', `/${code}/chat`, { text }),
  playoff: (code: Code, body: PlayoffRequest) => request('POST', `/${code}/playoff`, body),

  // The practice modes of the Voice room (/sound-input).
  practiceRun: (run: PracticeRun) => call('POST', '/practice/runs', run),
  practiceBest: async (mode: PracticeMode, preset: PresetId): Promise<PracticeBoard> =>
    parsePracticeBoard(await call('GET', `/practice/best?mode=${mode}&preset=${preset}`)),
  seat: (code: Code, action: SeatAction) => request('POST', `/${code}/seats`, action),
  answerSeat: (code: Code, accept: boolean) => request('POST', `/${code}/seats/answer`, { accept }),

  me: async () => parseMe(await call('GET', '/me')),
  setName: async (name: string) => parseMe(await call('PUT', '/me/name', { name })),
  clearName: async () => parseMe(await call('DELETE', '/me/name')),
  myGames: async () => parseMyGames(await call('GET', '/me/games')),
  blocks: async () => parseBlocks(await call('GET', '/me/blocks')),
  statsPrivacy: async () => requireStatsPrivacy(await call('GET', '/me/stats-privacy')),
  setStatsPrivacy: async (hidden: boolean) => requireStatsPrivacy(await call('PUT', '/me/stats-privacy', { private: hidden })),
  block: async (person: PersonId, name: string) => parseBlocks(await call('PUT', `/me/blocks/${person}`, { name })),
  unblock: async (person: PersonId) => parseBlocks(await call('DELETE', `/me/blocks/${person}`)),
  report: (report: { code: Code; reason: ReportReason; note: string } & ({ message: number } | { person: PersonId })) => call('POST', '/reports', report),
  previews: async (): Promise<Previews> => parsePreviews(await call('GET', '/previews')),
  logout: () => call('POST', '/auth/logout'),
  // Login is a full page visit to GitHub and back to `returnTo`, by default this page.
  loginUrl: (returnTo = location.href) => `/api/auth/login?return=${encodeURIComponent(returnTo)}`,

  // Sends finished games in batches. Returns the public id of each result (by result id) that
  // the server keeps under another public id than the device sent.
  async uploadResults(results: readonly ResultUpload[]): Promise<Map<string, DeviceGameId>> {
    const renamed = new Map<string, DeviceGameId>();
    for (let start = 0; start < results.length; start += RESULTS_PER_UPLOAD) {
      const answer = await call('POST', '/results', { results: results.slice(start, start + RESULTS_PER_UPLOAD) });
      const ids = typeof answer === 'object' && answer !== null && 'renamed' in answer ? answer.renamed : undefined;
      if (typeof ids !== 'object' || ids === null) throw new Error('invalid answer from /api/results');
      for (const [resultId, value] of Object.entries(ids)) {
        const id = parseDeviceGameId(value);
        if (id === undefined) throw new Error('invalid game id from /api/results');
        renamed.set(resultId, id);
      }
    }
    return renamed;
  },

  game: async (id: GameId): Promise<PublicGame> => parsePublicGame(await call('GET', `/games/${id}`)),
  history: async (offset: number): Promise<HistoryPage> => parseHistoryPage(await call('GET', `/me/history?offset=${offset}`)),
  async records(): Promise<Records> {
    const answer = await call('GET', '/me/records');
    if (typeof answer !== 'object' || answer === null || !('records' in answer)) throw new Error('invalid answer from /api/me/records');
    return parseRecords(answer.records);
  },
  async achievements(): Promise<AchievementProgress[]> {
    const parsed = parseAchievements(await call('GET', '/me/achievements'));
    if (parsed === undefined) throw new Error('invalid answer from /api/me/achievements');
    return parsed;
  },
  // Hides every finished game of this player from their history on the server.
  clearHistory: () => call('DELETE', '/me/history'),
  // Deletes the data of this player on the server, and of the account when this browser is logged in. It logs out.
  deleteData: () => call('DELETE', '/me'),
  // The person ids of the players who deleted their data since `since`, and the server time for the next call.
  deletedPeople: async (since: EpochMs) => parseDeletedPeople(await call('GET', `/deleted?since=${since}`)),
  // The metrics of this device for a finished online game that it played.
  gameMetrics: (id: OnlineGameId, metrics: Metrics) => call('POST', `/games/${id}/metrics`, metrics),
  // A fault report for the stats page. The caller ignores a failure: a report must never cause another fault.
  event: (event: ClientEvent) => call('POST', '/events', event),
  // The aggregates of the stats page. The page checks the shape (src/stats/main.ts).
  stats: (filter: StatsFilter): Promise<unknown> => call('GET', `/stats${statsQuery(filter)}`),

  // The Nearby lobby (server/lobby.ts). The server holds an announcement until a guest answers, or for about 25 s.
  announceNearby: async (offer: string, id: HostId | undefined, signal: AbortSignal): Promise<Announced> =>
    parseAnnounced(await call('POST', '/nearby/hosts', { offer, ...(id === undefined ? {} : { id }) }, signal)),
  nearbyHosts: async (): Promise<LobbyHost[]> => parseLobbyHosts(await call('GET', '/nearby/hosts')),
  answerNearby: (id: HostId, offer: string, answer: string) => call('POST', `/nearby/hosts/${id}/answer`, { answer, offer }),

  // Calls onChange after every change, and after each reconnect in case a change was missed.
  // The token marks this page's seats as present, so the other player sees "here" or "away".
  subscribe(code: Code, onChange: () => void): () => void {
    const source = new EventSource(`/api/sessions/${code}/events?player=${encodeURIComponent(token)}`);
    source.onmessage = () => onChange();
    source.onopen = () => onChange();
    return () => source.close();
  },
};
