// The Nearby lobby contract between the page and the server (see server/lobby.ts).
// A host announces its open game with an offer code. A guest on the same network reads the list,
// and sends its answer code to the host through the server.
import { DEVICE_KINDS, type DeviceKind } from './device.ts';
import { MAX_CODE_LENGTH } from './signal.ts';

// The server makes a host id from 12 random bytes in base64url.
export type HostId = string & { readonly __brand: 'HostId' };
const HOST_ID_LENGTH = 16;
const HOST_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function asHostId(value: unknown): HostId | undefined {
  if (typeof value !== 'string' || value.length !== HOST_ID_LENGTH) return undefined;
  return [...value].every((char) => HOST_ID_CHARS.includes(char)) ? (value as HostId) : undefined;
}

// A hosted game as a guest sees it in the list.
export type LobbyHost = { id: HostId; name: string; device: DeviceKind; age: number; offer: string };
// The answer to an announcement: the host id, and the answer code of a guest, when one came.
export type Announced = { id: HostId; answer: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// Only the shape. The server decodes each code fully before it uses it (decodeSignal in signal.ts).
const isCode = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= MAX_CODE_LENGTH;

// POST /api/nearby/hosts. Without an id, the host announces a new game. With an id, it holds its entry.
export function parseAnnounce(value: unknown): { offer: string; id: HostId | undefined } | undefined {
  if (!isRecord(value) || !isCode(value.offer)) return undefined;
  if (value.id === undefined) return { offer: value.offer, id: undefined };
  const id = asHostId(value.id);
  return id === undefined ? undefined : { offer: value.offer, id };
}

// POST /api/nearby/hosts/{host}/answer. The offer says which offer the answer is for: a host makes a
// fresh offer after each guest, and an answer to an older offer cannot connect.
export function parseAnswerRequest(value: unknown): { answer: string; offer: string } | undefined {
  return isRecord(value) && isCode(value.answer) && isCode(value.offer) ? { answer: value.answer, offer: value.offer } : undefined;
}

export function parseAnnounced(value: unknown): Announced {
  const id = isRecord(value) ? asHostId(value.id) : undefined;
  const answer = isRecord(value) ? value.answer : undefined;
  if (id === undefined || !(answer === null || isCode(answer))) throw new Error('invalid answer from /api/nearby/hosts');
  return { id, answer };
}

function parseLobbyHost(value: unknown): LobbyHost {
  if (!isRecord(value)) throw new Error('a lobby host is not an object');
  const { id, name, device, age, offer } = value;
  const hostId = asHostId(id);
  const kind = DEVICE_KINDS.find((known) => known === device);
  if (hostId === undefined || kind === undefined || typeof name !== 'string' || name === '' || !isCode(offer)) {
    throw new Error('invalid host in the Nearby list');
  }
  if (typeof age !== 'number' || !Number.isInteger(age) || age < 0) throw new Error('invalid host age in the Nearby list');
  return { id: hostId, name, device: kind, age, offer };
}

export function parseLobbyHosts(value: unknown): LobbyHost[] {
  if (!isRecord(value) || !Array.isArray(value.hosts)) throw new Error('invalid answer from /api/nearby/hosts');
  return value.hosts.map(parseLobbyHost);
}
