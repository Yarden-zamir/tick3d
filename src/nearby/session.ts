// Nearby sessions. The host device holds the session in its device backend (src/local.ts) and
// answers guests over WebRTC with the same session rules as the server (src/session/core.ts).
// A guest reaches the host through the same calls as the server, so the page treats both alike.
import type { Player } from '../game.ts';
import type { LocalBackend } from '../local.ts';
import {
  type Code,
  type GameId,
  type PlayerToken,
  type SessionView,
  asPlayerToken,
  parseMoveRequest,
  parseSessionUpdate,
  parseSessionView,
} from '../protocol.ts';
import * as core from '../session/core.ts';
import type { SessionDoc } from '../session/format.ts';
import type { Channel } from './peer.ts';
import { RpcError, type RpcMethod, rpcClient, rpcServer } from './rpc.ts';
import type { Hello } from './signal.ts';

type Guest = { hello: Hello; token: PlayerToken | undefined; server: ReturnType<typeof rpcServer> };
type GuestSummary = { hello: Hello; seat: Player | null };

const argsOf = (args: unknown): Record<string, unknown> =>
  typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

export function createNearbyHost(local: LocalBackend, code: Code, hostToken: PlayerToken) {
  const guests = new Set<Guest>();
  const changeListeners = new Set<() => void>();
  // Calls that arrive after stop() get a refusal, also in the moment before each channel closes.
  let stopped = false;

  // The host's own seat is present while it hosts. A guest's seat is present while its channel is open.
  function presence(doc: SessionDoc): Record<Player, boolean> {
    const connected = new Set<string>([hostToken, ...[...guests].flatMap((guest) => (guest.token ? [guest.token] : []))]);
    return { X: doc.seats.X !== null && connected.has(doc.seats.X), O: doc.seats.O !== null && connected.has(doc.seats.O) };
  }
  local.setPresence(code, presence);

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
    if (method === 'join') {
      const token = asPlayerToken(fields.token);
      if (token === undefined || token === hostToken) throw new RpcError(400, 'A guest needs its own player token.');
      guest.token = token;
    }
    const identity: core.Identity = new Set(guest.token ? [guest.token] : []);
    const now = Date.now();
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
          return (doc) => core.chat(doc, identity, fields.text, now);
      }
    })();
    const { doc, version } = await local.change(code, rule);
    if (method === 'join') guestsChanged();
    return core.viewOf(doc, { code, version, identity, now: Date.now(), presence: presence(doc), players: { X: null, O: null } });
  }

  return {
    code,
    addGuest(channel: Channel, hello: Hello): void {
      const guest: Guest = { hello, token: undefined, server: undefined as never };
      guest.server = rpcServer(channel, (method, args) => handle(guest, method, args));
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
    shareLink(game: number, id: GameId): void {
      for (const guest of guests) guest.server.link(game, id);
    },

    stop(reason: string): void {
      stopped = true;
      for (const guest of guests) guest.server.bye(reason);
      guests.clear();
      unsubscribe();
      local.setPresence(code, undefined);
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
  return {
    load: (_code: Code) => view('get'),
    join: (_code: Code) => view('join', { token }),
    move: (_code: Code, request: unknown) => view('move', request),
    newGame: (_code: Code) => view('newGame'),
    update: (_code: Code, changes: unknown) => view('update', changes),
    lock: (_code: Code) => view('lock'),
    chat: (_code: Code, text: string) => view('chat', { text }),
    // One channel carries one session, so every change notice is for this session.
    subscribe: (_code: Code, onChange: () => void): (() => void) => rpc.onChanged(() => onChange()),
    onLink: (handler: (game: number, id: GameId) => void) => rpc.onLink(handler),
    // A guest that leaves on purpose gets no goodbye message.
    close(): void {
      ended = true;
      channel.close();
    },
  };
}

export type NearbyGuest = ReturnType<typeof createNearbyGuest>;
