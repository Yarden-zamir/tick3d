// The Nearby lobby: open Nearby games that devices on the same network see in a list.
// A web page cannot broadcast or discover on a local network (no UDP, no mDNS API). So a host
// announces its game through this server, and a guest finds it here. Both devices must be online.
//
// The first announcement of a game answers at once with its id. Then the host holds one announce
// request with that id open. The request ends with the answer code of a guest, or after `waitMs`,
// and the host then sends the next request at once. The entry stays while a request
// is open, and for `graceMs` after one ends. When the host closes the page or ends the game, its
// request closes, and the entry goes at once. A host that loses the network without a word goes
// after `waitMs + graceMs` at most.
//
// Limit: the entries live in this process only, like the event streams. Revisit this with more
// than one API process.
import { randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { type HostId, type LobbyHost, asHostId } from '../src/nearby/lobby.ts';
import type { Hello } from '../src/nearby/signal.ts';
import type { PlayerToken } from '../src/protocol.ts';

export class LobbyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The network of a client address: an IPv4 address exactly, an IPv6 address by its /64 prefix.
// The devices of one home share one public IPv4 address (NAT) or one IPv6 /64 prefix.
// Limit: a home where one device uses IPv4 and another IPv6 has two networks here, so the two do
// not see each other. Revisit this when players report it; the code flow still connects them.
export function networkOf(address: string): string | undefined {
  const plain = address.split('%')[0] ?? '';
  if (isIPv4(plain)) return plain;
  if (!isIPv6(plain)) return undefined;
  const lower = plain.toLowerCase();
  // An IPv4 client on an IPv6 socket.
  if (lower.startsWith('::ffff:') && isIPv4(lower.slice('::ffff:'.length))) return lower.slice('::ffff:'.length);
  // An embedded IPv4 address at the end fills two groups.
  const groups = (part: string | undefined) =>
    part === undefined || part === '' ? [] : part.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group]));
  const [head, tail] = lower.split('::');
  const left = groups(head);
  const right = groups(tail);
  const full = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${full.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::/64`;
}

type Entry = {
  id: HostId;
  token: PlayerToken;
  network: string;
  hello: Hello;
  offer: string;
  // A WebRTC offer takes one answer. A used offer stays out of the list until the host sends a new one.
  used: boolean;
  since: number;
  // When the last open request of the host ended.
  endedAt: number;
  // Ends the open request of the host with an answer code, or with null.
  held: ((answer: string | null) => void) | undefined;
  // An answer that came while the host had no request open.
  answer: string | undefined;
};

export function createLobby(options: { perNetwork: number; total: number; waitMs: number; graceMs: number }) {
  const { perNetwork, total, waitMs, graceMs } = options;
  if (!(perNetwork >= 1 && total >= perNetwork && waitMs > 0 && graceMs > 0)) throw new RangeError('a lobby needs positive limits');
  const entries = new Map<HostId, Entry>();

  const present = (entry: Entry, now: number) => entry.held !== undefined || now - entry.endedAt < graceMs;
  function sweep(now: number): void {
    for (const [id, entry] of entries) if (!present(entry, now)) entries.delete(id);
  }

  function newId(): HostId {
    const id = asHostId(randomBytes(12).toString('base64url'));
    if (id === undefined) throw new Error('randomBytes made an invalid host id');
    return id;
  }

  return {
    count: () => entries.size,

    // Adds the entry of a host and resolves at once, or keeps the entry of `host.id` and holds the
    // request. A held request resolves with the answer code of a guest, or with null after `waitMs`.
    // An abort of `signal` during the hold (the host left) removes the entry.
    announce(
      host: { id: HostId | undefined; token: PlayerToken; network: string; hello: Hello; offer: string },
      signal: AbortSignal,
    ): { id: HostId; answer: Promise<string | null> } {
      const now = Date.now();
      sweep(now);
      let entry: Entry;
      if (host.id !== undefined) {
        const found = entries.get(host.id);
        if (found === undefined || found.token !== host.token || found.network !== host.network) {
          throw new LobbyError(404, 'This game is not in the list any more. Announce it again without an id.');
        }
        entry = found;
        // A new request takes the place of an open one.
        entry.held?.(null);
        if (host.offer !== entry.offer) {
          entry.offer = host.offer;
          entry.used = false;
        }
        entry.hello = host.hello;
      } else {
        if (entries.size >= total) throw new LobbyError(503, 'Too many games are in the list now. Try again later.');
        const onNetwork = [...entries.values()].filter((other) => other.network === host.network).length;
        if (onNetwork >= perNetwork) throw new LobbyError(429, `This network has ${perNetwork} games in the list already.`);
        entry = { ...host, id: newId(), used: false, since: now, endedAt: now, held: undefined, answer: undefined };
        entries.set(entry.id, entry);
      }

      // The page learns its id at once, and shows that the game is in the list.
      if (host.id === undefined) return { id: entry.id, answer: Promise.resolve(null) };
      const open = entry;
      const answer = new Promise<string | null>((resolve) => {
        if (open.answer !== undefined) {
          const waiting = open.answer;
          open.answer = undefined;
          open.endedAt = now;
          return resolve(waiting);
        }
        const finish = (code: string | null) => {
          if (open.held !== finish) return;
          clearTimeout(timer);
          signal.removeEventListener('abort', left);
          open.held = undefined;
          open.endedAt = Date.now();
          resolve(code);
        };
        const left = () => {
          if (open.held !== finish) return;
          finish(null);
          entries.delete(open.id);
        };
        const timer = setTimeout(() => finish(null), waitMs);
        open.held = finish;
        signal.addEventListener('abort', left);
        if (signal.aborted) left();
      });
      return { id: open.id, answer };
    },

    // The open games on a network, without the games of `token`. A used offer is not listed.
    list(network: string, token: PlayerToken | undefined): LobbyHost[] {
      const now = Date.now();
      sweep(now);
      return [...entries.values()]
        .filter((entry) => entry.network === network && !entry.used && entry.token !== token)
        .map((entry) => ({
          id: entry.id,
          name: entry.hello.name,
          device: entry.hello.device,
          age: Math.floor((now - entry.since) / 1000),
          offer: entry.offer,
        }));
    },

    // Passes the answer code of a guest to the host. A host on another network does not exist for the guest.
    // `offer` is the offer that the guest answered. Only the current offer of the host can connect.
    answer(id: HostId, network: string, offer: string, code: string): void {
      sweep(Date.now());
      const entry = entries.get(id);
      if (entry === undefined || entry.network !== network) throw new LobbyError(404, 'This game is not in the list any more.');
      if (entry.used || entry.offer !== offer) throw new LobbyError(409, 'Another device joins this game now. Try again in a few seconds.');
      entry.used = true;
      if (entry.held === undefined) entry.answer = code;
      else entry.held(code);
    },
  };
}
