// Nearby sessions. The host device holds the session in its device backend (src/local.ts) and
// answers guests over WebRTC with the same session rules as the server (src/session/core.ts).
// A guest reaches the host through the same calls as the server, so the page treats both alike.
import { isRecord } from '../guards.ts';
import type { Player } from '../game.ts';
import { epochNow } from '../epoch.ts';
import type { LocalBackend } from '../local.ts';
import { nameOf } from '../names.ts';
import {
  type Code,
  type DeviceGameId,
  type PersonId,
  type PlayerToken,
  type SeatAction,
  type SessionView,
  WATCHER_ID_LENGTH,
  asPlayerToken,
  parseMoveRequest,
  parseSeatAction,
  parseSeatAnswer,
  parseSessionUpdate,
  parseSessionView,
  personId,
} from '../protocol.ts';
import * as core from '../session/core.ts';
import type { SessionDoc } from '../session/format.ts';
import type { Channel } from './peer.ts';
import { RpcError, type RpcMethod, rpcClient, rpcServer } from './rpc.ts';
import type { Hello } from './signal.ts';

// `id` is the watcher id of the guest: random, so it says nothing about the token.
type Guest = { hello: Hello; token: PlayerToken | undefined; id: string; server: ReturnType<typeof rpcServer> };
type GuestSummary = { hello: Hello; seat: Player | null };

const argsOf = (args: unknown): Record<string, unknown> => (isRecord(args) ? args : {});

const randomWatcherId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(WATCHER_ID_LENGTH / 2)), (byte) => byte.toString(16).padStart(2, '0')).join('');

// `hostName` is the device name of the host, which also names the host's seat.
export function createNearbyHost(local: LocalBackend, code: Code, hostToken: PlayerToken, hostName: () => string) {
  const guests = new Set<Guest>();
  const changeListeners = new Set<() => void>();
  const hostId = randomWatcherId();
  // The device name of each guest token, kept after the guest leaves, so its seat keeps the name.
  const names = new Map<string, string>();
  // The person id of each known token (personId is async, the views are not), kept like the names.
  const persons = new Map<string, PersonId>();
  void personId(hostToken).then((id) => {
    persons.set(hostToken, id);
    guestsChanged();
  });
  // Calls that arrive after stop() get a refusal, also in the moment before each channel closes.
  let stopped = false;

  // The host's own seat is present while it hosts. A guest's seat is present while its channel is open.
  // A connected device without a seat (the host too) is a watcher. Each device shows with its device name.
  function audience(doc: SessionDoc): core.Audience {
    const connected = new Map<string, string>([[hostToken, hostId]]);
    for (const guest of guests) if (guest.token !== undefined && !connected.has(guest.token)) connected.set(guest.token, guest.id);
    const seated = (token: string) => token === doc.seats.X || token === doc.seats.O;
    return {
      presence: { X: doc.seats.X !== null && connected.has(doc.seats.X), O: doc.seats.O !== null && connected.has(doc.seats.O) },
      watchers: [...connected].filter(([token]) => !seated(token)).map(([token, id]) => ({ id, token, player: null })),
      name: (token) => (token === hostToken ? hostName() : (names.get(token) ?? nameOf(token))),
      person: (token) => persons.get(token) ?? null,
    };
  }
  local.setAudience(code, audience);

  const guestsChanged = () => {
    local.notify(code);
    for (const listener of changeListeners) listener();
  };
  // Every change, from the host's page or from a guest, reaches every guest.
  const unsubscribe = local.subscribe(code, () => {
    for (const guest of guests) guest.server.notifyChanged();
  });

  // Runs one guest call with the guest's identity. A guest proves nothing but its token,
  // exactly like a browser on the server, so a guest can never act for the host's seat.
  async function handle(guest: Guest, method: RpcMethod, args: unknown): Promise<SessionView> {
    if (stopped) throw new RpcError(410, 'The host ended the game.');
    const fields = argsOf(args);
    const unknownBefore = guest.token === undefined;
    // A guest names its token with join, and with get from the version with seat controls on, so a
    // watcher that never joined is known too. A guest keeps the first token it names.
    if (method === 'join' || (method === 'get' && fields.token !== undefined)) {
      const token = asPlayerToken(fields.token);
      if (token === undefined || token === hostToken || (guest.token !== undefined && guest.token !== token)) {
        throw new RpcError(400, 'A guest needs its own player token.');
      }
      guest.token = token;
      names.set(token, guest.hello.name);
      if (!persons.has(token)) persons.set(token, await personId(token));
    }
    const identity: core.Identity = new Set(guest.token ? [guest.token] : []);
    const now = epochNow();
    const rule = ((): ((doc: SessionDoc) => SessionDoc) => {
      switch (method) {
        case 'get':
          return (doc) => doc;
        case 'join': {
          const token = guest.token;
          if (token === undefined) throw new Error('join without a token');
          return (doc) => core.join(doc, identity, token);
        }
        case 'move': {
          const request = parseMoveRequest(args);
          if (request === undefined) throw new RpcError(400, 'A move needs game, moveCount and cell.');
          return (doc) => core.move(doc, identity, request, now);
        }
        case 'newGame':
          return (doc) => core.newGame(doc, identity);
        case 'update': {
          const changes = parseSessionUpdate(args);
          if (changes === undefined) throw new RpcError(400, 'The update is not valid.');
          return (doc) => core.update(doc, identity, changes);
        }
        case 'lock':
          return (doc) => core.lock(doc, identity);
        case 'chat':
          return (doc) => core.chat(doc, identity, fields.text, now, guest.token === undefined ? null : (persons.get(guest.token) ?? null));
        case 'seat': {
          const action = parseSeatAction(args);
          if (action === undefined) throw new RpcError(400, 'The seat change is not valid.');
          return (doc) => core.seat(doc, identity, action, audience(doc).watchers, now);
        }
        case 'answerSeat': {
          const answer = parseSeatAnswer(args);
          if (answer === undefined) throw new RpcError(400, 'The answer is not valid.');
          return (doc) => core.answerSeat(doc, identity, answer.accept, audience(doc).watchers, now);
        }
      }
    })();
    const { doc, version } = await local.change(code, rule);
    // A new token makes a new watcher or a new seat for the other devices.
    if (method === 'join' || (unknownBefore && guest.token !== undefined)) guestsChanged();
    return core.viewOf(doc, { code, version, identity, now: epochNow(), audience: audience(doc), players: { X: null, O: null } });
  }

  return {
    code,
    addGuest(channel: Channel, hello: Hello): void {
      // The server calls handle only after a message arrives, so `guest` exists by then.
      const guest: Guest = { hello, token: undefined, id: randomWatcherId(), server: rpcServer(channel, (method, args) => handle(guest, method, args)) };
      guests.add(guest);
      channel.onClose(() => {
        guests.delete(guest);
        guestsChanged();
      });
      guestsChanged();
    },

    // The connected guests and their seats, for the Nearby panel.
    async guests(): Promise<GuestSummary[]> {
      const { doc } = await local.change(code, (current) => current);
      return [...guests].map((guest) => ({
        hello: guest.hello,
        seat: guest.token === undefined ? null : (core.seatsOf(doc, new Set([guest.token]))[0] ?? null),
      }));
    },

    onGuestsChanged(listener: () => void): () => void {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },

    // Gives every guest the public id of a finished game, so all devices share the host's game link.
    shareLink(game: number, id: DeviceGameId): void {
      for (const guest of guests) guest.server.link(game, id);
    },

    stop(reason: string): void {
      stopped = true;
      for (const guest of guests) guest.server.bye(reason);
      guests.clear();
      unsubscribe();
      local.setAudience(code, undefined);
      local.notify(code);
    },
  };
}

export type NearbyHost = ReturnType<typeof createNearbyHost>;

// A guest's backend: the same calls as the server, answered by the host over the data channel.
export function createNearbyGuest(channel: Channel, token: PlayerToken, onBye: (reason: string) => void) {
  const rpc = rpcClient(channel);
  // The host's goodbye comes first and then the channel closes, so the first reason wins.
  let ended = false;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    onBye(reason);
  };
  rpc.onBye(end);
  channel.onClose(() => end('The connection to the host closed.'));
  const view = async (method: RpcMethod, args: unknown = {}) => parseSessionView(await rpc.call(method, args));
  // The token tells the host who watches, so a player can give a seat to this device.
  const load = () => view('get', { token });
  return {
    load: (_code: Code) => load(),
    // The first view, before the guest knows the code of the hosted session.
    loadHosted: load,
    join: (_code: Code) => view('join', { token }),
    move: (_code: Code, request: unknown) => view('move', request),
    newGame: (_code: Code) => view('newGame'),
    update: (_code: Code, changes: unknown) => view('update', changes),
    lock: (_code: Code) => view('lock'),
    chat: (_code: Code, text: string) => view('chat', { text }),
    seat: (_code: Code, action: SeatAction) => view('seat', action),
    answerSeat: (_code: Code, accept: boolean) => view('answerSeat', { accept }),
    // One channel carries one session, so every change notice is for this session.
    subscribe: (_code: Code, onChange: () => void): (() => void) => rpc.onChanged(() => onChange()),
    onLink: (handler: (game: number, id: DeviceGameId) => void) => rpc.onLink(handler),
    // A guest that leaves on purpose gets no goodbye message.
    close(): void {
      ended = true;
      channel.close();
    },
  };
}

export type NearbyGuest = ReturnType<typeof createNearbyGuest>;
