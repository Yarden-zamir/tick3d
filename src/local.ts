// The device backend: computer and friend games, and Nearby games this device hosts. It runs the
// same session rules as the server (src/session/core.ts) over IndexedDB, so these games work offline.
import { isRecord } from './guards.ts';
import type { Difficulty } from './ai.ts';
import type { TimeControl } from './clock.ts';
import type { Player } from './game.ts';
import { epochNow } from './epoch.ts';
import type { DeviceDb, DeviceSession } from './device-db.ts';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  type Code,
  type MoveRequest,
  type PlayerInfo,
  type PlayerToken,
  type SeatAction,
  type SessionUpdate,
  type SessionView,
  normalizeCode,
} from './protocol.ts';
import { nameOf } from './names.ts';
import * as core from './session/core.ts';
import { CURRENT_FORMAT, type SessionDoc, parseDoc } from './session/format.ts';

type LocalMode = 'computer' | 'friend' | 'nearby';

type NewLocalSession = {
  mode: LocalMode;
  name: string;
  clock: TimeControl;
  // The seat of the player at this device. A friend game holds both seats.
  human: Player;
  difficulty?: Difficulty;
};

type LocalSummary = { code: Code; mode: LocalMode; name: string; games: number; updatedAt: number; doc: SessionDoc };

// Undefined for an online document: the device does not hold online sessions in this store.
function summaryOf(row: DeviceSession, doc: SessionDoc): LocalSummary | undefined {
  if (doc.mode === 'online') return undefined;
  return {
    code: row.code,
    mode: doc.mode,
    name: doc.name,
    games: doc.games.filter((game) => game.moves.length > 0).length,
    updatedAt: row.updatedAt,
    doc,
  };
}

function randomCode(): Code {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('') as Code;
}

export function createLocalBackend(
  db: DeviceDb,
  token: PlayerToken,
  // The account of this device's player, shown on its seats. Null without a login.
  account: () => PlayerInfo | null,
) {
  const listeners = new Map<Code, Set<() => void>>();
  // A Nearby host reports which seats are connected, its watchers and their names.
  // Other sessions on this device have both seats present, no watchers, and no other person to block.
  const audiences = new Map<Code, (doc: SessionDoc) => core.Audience>();
  const audienceOf = (code: Code, doc: SessionDoc): core.Audience =>
    audiences.get(code)?.(doc) ?? { presence: { X: doc.seats.X !== null, O: doc.seats.O !== null }, watchers: [], name: nameOf, person: () => null };
  // Other tabs of this device hear about changes, so two open tabs show the same game.
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('tick3d-local');
  const fire = (code: Code) => listeners.get(code)?.forEach((listener) => listener());
  if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
    // Only this file posts on the channel, always a valid code.
    const code = typeof event.data === 'string' ? normalizeCode(event.data) : undefined;
    if (code === undefined) throw new Error(`unexpected message on the local channel: ${String(event.data)}`);
    fire(code);
  };

  // One change at a time in this tab, like the server queue. Two tabs that change the same
  // game in the same instant keep the later write; revisit if that ever loses a move in practice.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function read(code: Code): Promise<DeviceSession & { parsed: SessionDoc }> {
    const row = await db.get('sessions', code);
    if (row === undefined) throw new core.SessionError(404, `No game with code ${code} on this device.`);
    return { ...row, parsed: parseDoc(row.doc) };
  }

  async function write(row: DeviceSession, doc: SessionDoc): Promise<DeviceSession> {
    // Every write passes the same check as every read, as on the server.
    const stored: unknown = JSON.parse(JSON.stringify(doc));
    parseDoc(stored);
    const next = { code: row.code, doc: stored, version: row.version + 1, updatedAt: Date.now() };
    await db.put('sessions', next);
    fire(row.code);
    channel?.postMessage(row.code);
    return next;
  }

  // The device holds its own seats; in a computer game it also moves for the computer.
  const identity = (withComputer = false): core.Identity => new Set(withComputer ? [token, core.COMPUTER_TOKEN] : [token]);

  // The view is always the human's: `you` is the seat of this device's player, also after a computer move.
  function view(row: DeviceSession, doc: SessionDoc): SessionView {
    const info = account();
    const seatInfo = (seat: Player) => (doc.seats[seat] === token ? info : null);
    return core.viewOf(doc, {
      code: row.code,
      version: row.version,
      identity: identity(),
      now: epochNow(),
      audience: audienceOf(row.code, doc),
      players: { X: seatInfo('X'), O: seatInfo('O') },
    });
  }

  // Loads, records a timeout, writes an older format back, and applies one rule.
  function apply(code: Code, rule: (doc: SessionDoc) => SessionDoc): Promise<{ row: DeviceSession; doc: SessionDoc }> {
    return serialized(async () => {
      const loaded = await read(code);
      let row: DeviceSession = loaded;
      let doc = core.settle(loaded.parsed, epochNow()) ?? loaded.parsed;
      const stale = !isRecord(loaded.doc) || loaded.doc.format !== CURRENT_FORMAT;
      if (doc !== loaded.parsed || stale) row = await write(row, doc);
      const next = rule(doc);
      if (next !== doc) {
        row = await write(row, next);
        doc = next;
      }
      return { row, doc };
    });
  }

  async function change(code: Code, rule: (doc: SessionDoc) => SessionDoc): Promise<SessionView> {
    const { row, doc } = await apply(code, rule);
    return view(row, doc);
  }

  return {
    create: (options: NewLocalSession): Promise<SessionView> =>
      serialized(async () => {
        const { mode, name, clock, human, difficulty } = options;
        const seats: Record<Player, string | null> =
          mode === 'friend'
            ? { X: token, O: token }
            : mode === 'computer'
              ? { X: human === 'X' ? token : core.COMPUTER_TOKEN, O: human === 'O' ? token : core.COMPUTER_TOKEN }
              : // A Nearby host takes its seat; the first guest takes the other.
                { X: human === 'X' ? token : null, O: human === 'O' ? token : null };
        const computer = mode === 'computer' && difficulty !== undefined ? { difficulty, seat: human === 'X' ? 'O' : 'X' } as const : undefined;
        const doc = core.createDoc({ name, mode, clock, seats, ...(computer ? { computer } : {}) });
        let code = randomCode();
        while ((await db.get('sessions', code)) !== undefined) code = randomCode();
        const row = await write({ code, doc: null, version: 0, updatedAt: 0 }, doc);
        return view(row, doc);
      }),

    load: (code: Code) => change(code, (doc) => doc),
    move: (code: Code, request: MoveRequest) => change(code, (doc) => core.move(doc, identity(), request, epochNow())),
    // The page plays the computer's moves through this, with the computer's token added.
    computerMove: (code: Code, request: MoveRequest) =>
      change(code, (doc) => core.move(doc, identity(true), request, epochNow())),
    newGame: (code: Code) => change(code, (doc) => core.newGame(doc, identity())),
    update: (code: Code, changes: SessionUpdate) => change(code, (doc) => core.update(doc, identity(), changes)),
    lock: (code: Code) => change(code, (doc) => core.lock(doc, identity())),
    chat: (code: Code, text: string) => change(code, (doc) => core.chat(doc, identity(), text, epochNow(), audienceOf(code, doc).person(token))),
    undo: (code: Code, count: number) => change(code, (doc) => core.undo(doc, identity(true), count)),
    // A device-held session has nobody else to join; a Nearby guest joins through the host.
    join: (code: Code) => change(code, (doc) => doc),
    // The seat changes of the host's player in a Nearby game.
    seat: (code: Code, action: SeatAction) =>
      change(code, (doc) => core.seat(doc, identity(), action, audienceOf(code, doc).watchers, epochNow())),
    answerSeat: (code: Code, accept: boolean) =>
      change(code, (doc) => core.answerSeat(doc, identity(), accept, audienceOf(code, doc).watchers, epochNow())),

    // For a Nearby host: who is connected, and a nudge to redraw when a guest comes or goes.
    setAudience(code: Code, audience: ((doc: SessionDoc) => core.Audience) | undefined): void {
      if (audience === undefined) audiences.delete(code);
      else audiences.set(code, audience);
    },
    notify: (code: Code) => fire(code),

    subscribe(code: Code, onChange: () => void): () => void {
      const set = listeners.get(code) ?? new Set();
      listeners.set(code, set);
      set.add(onChange);
      return () => set.delete(onChange);
    },

    // Every session on this device, newest first.
    // A row that fails parseDoc stays out of the list, so one damaged row does not hide the others.
    // Opening that row by its code still throws, so the damage stays visible there.
    async list(): Promise<LocalSummary[]> {
      const summaries: LocalSummary[] = [];
      const damaged: Code[] = [];
      for (const row of await db.all('sessions')) {
        let doc: SessionDoc;
        try {
          doc = parseDoc(row.doc);
        } catch {
          damaged.push(row.code);
          continue;
        }
        const summary = summaryOf(row, doc);
        if (summary !== undefined) summaries.push(summary);
      }
      if (damaged.length > 0) console.warn('Sessions on this device that do not parse:', damaged);
      return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    // Deletes sessions on this device that no game has a move in and that nobody changed for `ageMs`,
    // except `keep`. A row that does not parse stays, so damage stays visible.
    pruneEmpty: (ageMs: number, keep?: Code) =>
      serialized(async () => {
        const cutoff = Date.now() - ageMs;
        for (const row of await db.all('sessions')) {
          if (row.code === keep || row.updatedAt >= cutoff) continue;
          let doc: SessionDoc;
          try {
            doc = parseDoc(row.doc);
          } catch {
            continue;
          }
          if (core.isEmptySession(doc)) await db.delete('sessions', row.code);
        }
      }),

    // One session on this device, or undefined when the device does not hold it.
    // Throws when the stored document does not parse.
    async summary(code: Code): Promise<LocalSummary | undefined> {
      const row = await db.get('sessions', code);
      return row === undefined ? undefined : summaryOf(row, parseDoc(row.doc));
    },

    // The raw document, for the Nearby host. It answers guests with the same rules as the server.
    async change(code: Code, rule: (doc: SessionDoc) => SessionDoc): Promise<{ code: Code; doc: SessionDoc; version: number }> {
      const { row, doc } = await apply(code, rule);
      return { code, doc, version: row.version };
    },
  };
}

export type LocalBackend = ReturnType<typeof createLocalBackend>;
