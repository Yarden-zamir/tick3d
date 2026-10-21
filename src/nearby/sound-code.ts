// Short, bounded packets for the sound alternative to the return QR. The offer fingerprint keeps
// another nearby game's reply out; the reply fingerprint checks the complete reassembled message.
import { MAX_CODE_LENGTH } from './signal.ts';

const MAGIC = [0x54, 0x33, 0x53, 1] as const;
const HEADER = 24;
const PART_BYTES = 96;
const MAX_PARTS = 8;
const ANSWER_PREFIX = 'T3B1.';

const fingerprint = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 8);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export function canSendSoundReply(answer: string): boolean {
  const body = answer.slice(ANSWER_PREFIX.length);
  const bytes = Math.floor(body.length * 3 / 4);
  return answer.length <= MAX_CODE_LENGTH && answer.startsWith(ANSWER_PREFIX) && /^[\w-]+$/.test(body)
    && body.length % 4 !== 1 && bytes > 0 && bytes <= MAX_PARTS * PART_BYTES;
}

export async function soundPackets(offer: string, answer: string): Promise<Uint8Array<ArrayBuffer>[]> {
  if (answer.length > MAX_CODE_LENGTH || !answer.startsWith(ANSWER_PREFIX) || !/^[\w-]+$/.test(answer.slice(ANSWER_PREFIX.length))) {
    throw new Error('This is not a Wi-Fi reply code.');
  }
  const body = answer.slice(ANSWER_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(body + '='.repeat((4 - body.length % 4) % 4)), (char) => char.charCodeAt(0));
  const count = Math.ceil(bytes.length / PART_BYTES);
  if (count < 1 || count > MAX_PARTS) throw new Error('This reply is too long for sound. Scan the reply instead.');
  const [offerId, replyId] = await Promise.all([fingerprint(new TextEncoder().encode(offer)), fingerprint(bytes)]);
  return Array.from({ length: count }, (_, index) => {
    const part = bytes.slice(index * PART_BYTES, (index + 1) * PART_BYTES);
    const packet = new Uint8Array(HEADER + part.length);
    packet.set(MAGIC);
    packet.set(offerId, 4);
    packet.set(replyId, 12);
    packet[20] = index;
    packet[21] = count;
    packet[22] = bytes.length >> 8;
    packet[23] = bytes.length & 255;
    packet.set(part, HEADER);
    return packet;
  });
}

export async function soundReply(offer: string, progress: (received: number, total: number) => void) {
  const offerId = await fingerprint(new TextEncoder().encode(offer));
  // A stray/forged first part must not pin the listener to one reply id. Keep a small bounded set
  // of candidates, so a genuine complete reply can still win without unbounded memory growth.
  const replies = new Map<string, { id: Uint8Array; length: number; parts: Map<number, Uint8Array>; checking?: Promise<string | undefined> }>();
  let delivered = false;
  return async (packet: Uint8Array): Promise<string | undefined> => {
    if (delivered) return;
    if (packet.length <= HEADER || packet.length > HEADER + PART_BYTES || !MAGIC.every((byte, i) => packet[i] === byte) || !same(packet.subarray(4, 12), offerId)) return;
    const index = packet[20] ?? 0;
    const count = packet[21] ?? 0;
    const size = ((packet[22] ?? 0) << 8) | (packet[23] ?? 0);
    if (size < 1 || size > MAX_PARTS * PART_BYTES || count !== Math.ceil(size / PART_BYTES) || index >= count) return;
    if (packet.length - HEADER !== Math.min(PART_BYTES, size - index * PART_BYTES)) return;
    const id = packet.slice(12, 20);
    const key = id.join(',');
    let reply = replies.get(key);
    if (reply === undefined) {
      if (replies.size >= 4) {
        const oldest = replies.keys().next().value;
        if (oldest !== undefined) replies.delete(oldest);
      }
      reply = { id, length: size, parts: new Map() };
      replies.set(key, reply);
    }
    if (reply.length !== size) return;
    if (!reply.parts.has(index)) {
      reply.parts.set(index, packet.slice(HEADER));
      progress(reply.parts.size, count);
    }
    if (reply.parts.size !== count) return;
    if (reply.checking === undefined) {
      const candidate = reply;
      const bytes = new Uint8Array(candidate.length);
      for (const [i, part] of candidate.parts) bytes.set(part, i * PART_BYTES);
      candidate.checking = fingerprint(bytes).then((hash) => {
        if (!same(hash, candidate.id)) {
          if (replies.get(key) === candidate) replies.delete(key);
          return undefined;
        }
        return ANSWER_PREFIX + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      });
    }
    const result = await reply.checking;
    if (result === undefined || delivered) return;
    delivered = true;
    return result;
  };
}
