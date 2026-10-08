// Deletion notices. A player who deletes their data (DELETE /api/me) leaves a notice with their person
// ids for a year. Pages read the notices (GET /api/deleted) and remove that person from their own
// copies: cached online games, and the sessions and results of a Nearby host.
import { type EpochMs, isEpochMs } from './epoch.ts';
import { isRecord, isUnknownArray } from './guards.ts';
import type { SessionDoc } from './session/format.ts';
import type { Player } from './game.ts';
import { type PersonId, type ResultUpload, type SessionView, parsePersonId, personId } from './protocol.ts';

// The name that stands for a player who deleted their data. The avatar of the name is a generated one, the same for all.
export const DELETED_NAME = 'Deleted player';

const SEATS = ['X', 'O'] as const satisfies readonly Player[];

type Deleted = ReadonlySet<PersonId>;
const isGone = (deleted: Deleted, person: PersonId | null | undefined) => person !== null && person !== undefined && deleted.has(person);

// A cached view without the deleted people: their name, account and person id go, and so do their
// chat lines. undefined when the view holds none of them.
export function scrubView(view: SessionView, deleted: Deleted): SessionView | undefined {
  const seats = SEATS.filter((seat) => isGone(deleted, view.people[seat]));
  const chat = view.chat.filter((message) => !isGone(deleted, message.by));
  const watchers = view.watchers.map((watcher) => (isGone(deleted, watcher.person) ? { ...watcher, name: DELETED_NAME, player: null, person: null } : watcher));
  if (seats.length === 0 && chat.length === view.chat.length && !view.watchers.some((watcher) => isGone(deleted, watcher.person))) return undefined;
  const names = { ...view.names };
  const players = { ...view.players };
  const people = { ...view.people };
  for (const seat of seats) {
    names[seat] = DELETED_NAME;
    players[seat] = null;
    people[seat] = null;
  }
  return { ...view, names, players, people, chat, watchers };
}

// A session that this device holds (a Nearby host) without the deleted people: their seat becomes
// free, and their chat lines go. undefined when the session holds none of them.
export async function scrubDoc(doc: SessionDoc, deleted: Deleted): Promise<SessionDoc | undefined> {
  const gone = async (token: string | null) => token !== null && deleted.has(await personId(token));
  const seats = { X: (await gone(doc.seats.X)) ? null : doc.seats.X, O: (await gone(doc.seats.O)) ? null : doc.seats.O };
  const freed = seats.X !== doc.seats.X || seats.O !== doc.seats.O;
  const chat = doc.chat.filter((message) => !isGone(deleted, message.by));
  const request = doc.seatRequest !== null && (freed || (await gone(doc.seatRequest.watcher)));
  if (!freed && !request && chat.length === doc.chat.length) return undefined;
  return { ...doc, seats, chat, seatRequest: request ? null : doc.seatRequest };
}

// A result of a Nearby host without the token of a deleted guest. undefined when the guest stays.
export async function scrubUpload(upload: ResultUpload, deleted: Deleted): Promise<ResultUpload | undefined> {
  if (upload.guest === null || !deleted.has(await personId(upload.guest))) return undefined;
  return { ...upload, guest: null };
}

// The answer of GET /api/deleted.
export function parseDeletedPeople(value: unknown): { people: PersonId[]; until: EpochMs } {
  const people = isRecord(value) && isUnknownArray(value.people) ? value.people.map(parsePersonId) : undefined;
  if (!isRecord(value) || people === undefined || !people.every((person) => person !== undefined) || !isEpochMs(value.until)) {
    throw new Error('invalid answer from /api/deleted');
  }
  return { people, until: value.until };
}
