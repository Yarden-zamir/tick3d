// The device backend: computer and friend games, and Nearby games this device hosts. It runs the
// same session rules as the server (src/session/core.ts) over IndexedDB, so these games work offline.
import type { Difficulty } from './ai.ts';
import type { TimeControl } from './clock.ts';
import type { Player } from './game.ts';
import type { DeviceDb, DeviceSession } from './device-db.ts';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  type Code,
  type MoveRequest,
  type PlayerInfo,
  type PlayerToken,
  type SessionUpdate,
  type SessionView,
} from './protocol.ts';
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
  // A Nearby host reports which seats are connected. Other sessions on this device are all present.
  const presenceOf = new Map<Code, (doc: SessionDoc) => Record<Player, boolean>>();
  // Other tabs of this device hear about changes, so two open tabs show the same game.
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('tick3d-local');
  const fire = (code: Code) => listeners.get(code)?.forEach((listener) => listener());
  if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'string') fire(event.data as Code);
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

  function view(row: DeviceSession, doc: SessionDoc, withComputer = false): SessionView {
    const info = account();
    const seatInfo = (seat: Player) => (doc.seats[seat] === token ? info : null);
    return core.viewOf(doc, {
      code: row.code,
      version: row.version,
      identity: identity(withComputer),
      now: Date.now(),
      presence: presenceOf.get(row.code)?.(doc) ?? { X: doc.seats.X !== null, O: doc.seats.O !== null },
      players: { X: seatInfo('X'), O: seatInfo('O') },
    });
  }

  // Loads, records a timeout, writes an older format back, and applies one rule.
  function apply(code: Code, rule: (doc: SessionDoc) => SessionDoc): Promise<{ row: DeviceSession; doc: SessionDoc }> {
    return serialized(async () => {
      const loaded = await read(code);
      let row: DeviceSession = loaded;
      let doc = core.settle(loaded.parsed, Date.now()) ?? loaded.parsed;
      const stale = (loaded.doc as { format?: unknown }).format !== CURRENT_FORMAT;
      if (doc !== loaded.parsed || stale) row = await write(row, doc);
      const next = rule(doc);
      if (next !== doc) {
        row = await write(row, next);
        doc = next;
      }
      return { row, doc };
    });
  }

  async function change(code: Code, rule: (doc: SessionDoc) => SessionDoc, withComputer = false): Promise<SessionView> {
    const { row, doc } = await apply(code, rule);
    return view(row, doc, withComputer);
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
    move: (code: Code, request: MoveRequest) => change(code, (doc) => core.move(doc, identity(), request, Date.now())),
    // The page plays the computer's moves through this, with the computer's token added.
    computerMove: (code: Code, request: MoveRequest) =>
      change(code, (doc) => core.move(doc, identity(true), request, Date.now()), true),
    newGame: (code: Code) => change(code, (doc) => core.newGame(doc, identity())),
    update: (code: Code, changes: SessionUpdate) => change(code, (doc) => core.update(doc, identity(), changes)),
    lock: (code: Code) => change(code, (doc) => core.lock(doc, identity())),
    chat: (code: Code, text: string) => change(code, (doc) => core.chat(doc, identity(), text, Date.now())),
    undo: (code: Code, count: number) => change(code, (doc) => core.undo(doc, identity(true), count)),
    // A device-held session has nobody else to join; a Nearby guest joins through the host.
    join: (code: Code) => change(code, (doc) => doc),

    // For a Nearby host: who is connected, and a nudge to redraw when a guest comes or goes.
    setPresence(code: Code, presence: ((doc: SessionDoc) => Record<Player, boolean>) | undefined): void {
      if (presence === undefined) presenceOf.delete(code);
      else presenceOf.set(code, presence);
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
