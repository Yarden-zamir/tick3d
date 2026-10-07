// Handshake codes for Nearby play. Two devices with no server must swap their WebRTC session
// descriptions once, by QR code or by copy and paste. A code holds the few fields of a description
// that change between connections, plus the sender's device kind and name. The receiver rebuilds a
// standard data channel description from a template. This makes a code about half as long as the
// compressed description, because deflate cannot shrink random fields such as keys and addresses.
//
// Format: "T3A1." (offer) or "T3B1." (answer), then base64url of deflate-raw of a JSON array:
//   [ufrag, pwd, fingerprint (base64url of the SHA-256 bytes), setup, candidates, device, name]
// with each candidate as [address, port, priority]. An mDNS address ("<uuid>.local") is packed as
// "~" + base64url of its 16 bytes. Change the version digit when the format changes, so a code from
// another version fails with a clear message.
import { isUnknownArray, keysOf } from '../guards.ts';
import type { DeviceKind } from './device.ts';

export type Hello = { device: DeviceKind; name: string };

const OFFER_TAG = 'T3A1.';
const ANSWER_TAG = 'T3B1.';
// The longest device name in a Hello. Shorter than a session name (protocol.ts), to keep codes short.
export const HELLO_NAME_MAX_LENGTH = 24;
// Limits for codes from an unknown device: the text, and the JSON after inflation.
export const MAX_CODE_LENGTH = 2000;
const MAX_INFLATED_BYTES = 4000;
const MAX_CANDIDATES = 8;

const DEVICE_CODES: Record<DeviceKind, string> = { phone: 'p', tablet: 't', computer: 'c' };
const SETUP_CODES = { actpass: 'a', active: 'c', passive: 'p' } as const;
type Setup = keyof typeof SETUP_CODES;

// The fields of a data channel description that change from one connection to the next.
type SdpFields = {
  ufrag: string;
  pwd: string;
  fingerprint: Uint8Array;
  setup: Setup;
  candidates: { address: string; port: number; priority: number }[];
};

function normalizeHelloName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= HELLO_NAME_MAX_LENGTH ? trimmed : undefined;
}

// ---- SDP fields ----

const HEX = '0123456789abcdef';
const ICE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
const ADDRESS_CHARS = '0123456789abcdefABCDEF.:';
const onlyChars = (text: string, allowed: string) => [...text].every((char) => allowed.includes(char));

// Reads the variable fields from a Chrome data channel description. Only UDP candidates are kept:
// two devices on one network connect over UDP.
export function readSdp(sdp: string): SdpFields {
  const lines = sdp.split('\r\n');
  const value = (prefix: string) => {
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    if (line === undefined) throw new Error(`the description has no ${prefix} line`);
    return line.slice(prefix.length);
  };
  const [algorithm, hex] = value('a=fingerprint:').split(' ');
  if (algorithm !== 'sha-256' || hex === undefined) throw new Error('the description has no SHA-256 fingerprint');
  const setup = value('a=setup:');
  const role = keysOf(SETUP_CODES).find((known) => known === setup);
  if (role === undefined) throw new Error(`unknown setup role ${setup}`);
  const candidates = lines
    .filter((line) => line.startsWith('a=candidate:'))
    .map((line) => line.slice('a=candidate:'.length).split(' '))
    .filter((fields) => fields[2]?.toLowerCase() === 'udp' && fields[1] === '1')
    .map(([, , , priority, address, port]) => ({ address: address ?? '', port: Number(port), priority: Number(priority) }));
  return {
    ufrag: value('a=ice-ufrag:'),
    pwd: value('a=ice-pwd:'),
    fingerprint: Uint8Array.from(hex.split(':'), (pair) => Number.parseInt(pair, 16)),
    setup: role,
    candidates,
  };
}

// Builds a standard data channel description from the variable fields.
export function buildSdp(fields: SdpFields): string {
  const fingerprint = [...fields.fingerprint].map((byte) => HEX[byte >> 4]! + HEX[byte & 15]!).join(':').toUpperCase();
  return [
    'v=0',
    'o=- 0 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...fields.candidates.map(({ address, port, priority }, index) => `a=candidate:${index + 1} 1 udp ${priority} ${address} ${port} typ host`),
    `a=ice-ufrag:${fields.ufrag}`,
    `a=ice-pwd:${fields.pwd}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${fields.setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}

// ---- Bytes and text ----

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
  let binary: string;
  try {
    binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  } catch {
    throw new Error('This is not a tick3d code.');
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// An mDNS name is a random UUID plus ".local": its 16 bytes take 22 characters instead of 42.
function packAddress(address: string): string {
  const uuid = address.endsWith('.local') ? address.slice(0, -'.local'.length).replaceAll('-', '') : '';
  if (uuid.length === 32 && onlyChars(uuid.toLowerCase(), HEX)) {
    return `~${toBase64Url(Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(uuid.slice(i * 2, i * 2 + 2), 16)))}`;
  }
  return address;
}

function unpackAddress(packed: string): string | undefined {
  if (packed.startsWith('~')) {
    const bytes = fromBase64Url(packed.slice(1));
    if (bytes.length !== 16) return undefined;
    const hex = [...bytes].map((byte) => HEX[byte >> 4]! + HEX[byte & 15]!).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.local`;
  }
  // A plain IPv4 or IPv6 address, when the browser does not hide it behind an mDNS name.
  return packed.length >= 3 && packed.length <= 45 && onlyChars(packed, ADDRESS_CHARS) ? packed : undefined;
}

async function pipeBytes(bytes: Uint8Array<ArrayBuffer>, transform: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('This code is too long to be a tick3d code.');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

// ---- Codes ----

export async function encodeSignal(desc: RTCSessionDescriptionInit, hello: Hello): Promise<string> {
  if (desc.type !== 'offer' && desc.type !== 'answer') throw new Error(`cannot encode a ${desc.type} description`);
  if (typeof desc.sdp !== 'string' || desc.sdp === '') throw new Error('the description has no SDP');
  const name = normalizeHelloName(hello.name);
  if (name === undefined) throw new Error(`a device name needs 1 to ${HELLO_NAME_MAX_LENGTH} characters`);
  const fields = readSdp(desc.sdp);
  if (fields.candidates.length === 0) throw new Error('the description has no network candidates');
  const packed = [
    fields.ufrag,
    fields.pwd,
    toBase64Url(fields.fingerprint),
    SETUP_CODES[fields.setup],
    fields.candidates.slice(0, MAX_CANDIDATES).map(({ address, port, priority }) => [packAddress(address), port, priority]),
    DEVICE_CODES[hello.device],
    name,
  ];
  const deflated = await pipeBytes(new TextEncoder().encode(JSON.stringify(packed)), new CompressionStream('deflate-raw'), MAX_INFLATED_BYTES);
  return (desc.type === 'offer' ? OFFER_TAG : ANSWER_TAG) + toBase64Url(deflated);
}

const DAMAGED = 'This code is damaged. Scan or copy it again.';

function readCandidate(value: unknown): SdpFields['candidates'][number] | undefined {
  if (!isUnknownArray(value) || value.length !== 3) return undefined;
  const [packed, port, priority] = value;
  const address = typeof packed === 'string' ? unpackAddress(packed) : undefined;
  if (address === undefined) return undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 0xffff_ffff) return undefined;
  return { address, port, priority };
}

// Reads a code from another device. Throws an Error with a message fit to show the player.
export async function decodeSignal(text: string): Promise<{ kind: 'offer' | 'answer'; desc: RTCSessionDescriptionInit; hello: Hello }> {
  const code = text.trim();
  if (code.length > MAX_CODE_LENGTH) throw new Error('This code is too long to be a tick3d code.');
  const kind = code.startsWith(OFFER_TAG) ? 'offer' : code.startsWith(ANSWER_TAG) ? 'answer' : undefined;
  if (kind === undefined) throw new Error('This is not a tick3d code, or it comes from another version.');
  // Every step that reads bytes is inside the try: a damaged field gives the DAMAGED message.
  const { value, fingerprintBytes, candidates } = await (async () => {
    try {
      const inflated = await pipeBytes(fromBase64Url(code.slice(OFFER_TAG.length)), new DecompressionStream('deflate-raw'), MAX_INFLATED_BYTES);
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inflated));
      if (!isUnknownArray(parsed) || parsed.length !== 7) throw new Error('the code is not an array of 7 fields');
      const [, , fingerprint, , rawCandidates] = parsed;
      return {
        value: parsed,
        fingerprintBytes: typeof fingerprint === 'string' ? fromBase64Url(fingerprint) : undefined,
        candidates: Array.isArray(rawCandidates) ? rawCandidates.map(readCandidate) : [],
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('This code is too long')) throw error;
      throw new Error(DAMAGED, { cause: error });
    }
  })();
  const [ufrag, pwd, , setupCode, , deviceCode, rawName] = value;
  const setup = keysOf(SETUP_CODES).find((role) => SETUP_CODES[role] === setupCode);
  const device = keysOf(DEVICE_CODES).find((kindName) => DEVICE_CODES[kindName] === deviceCode);
  const name = normalizeHelloName(rawName);
  const valid =
    typeof ufrag === 'string' && ufrag.length >= 4 && ufrag.length <= 256 && onlyChars(ufrag, ICE_CHARS) &&
    typeof pwd === 'string' && pwd.length >= 22 && pwd.length <= 256 && onlyChars(pwd, ICE_CHARS) &&
    fingerprintBytes?.length === 32 &&
    setup !== undefined &&
    device !== undefined &&
    name !== undefined && name === rawName &&
    candidates.length >= 1 && candidates.length <= MAX_CANDIDATES &&
    candidates.every((candidate) => candidate !== undefined);
  if (!valid) throw new Error(DAMAGED);
  const sdp = buildSdp({ ufrag, pwd, fingerprint: fingerprintBytes, setup, candidates });
  return { kind, desc: { type: kind, sdp }, hello: { device, name } };
}
