// The Idempotency-Key request header (IETF draft-ietf-httpapi-idempotency-key-header). A client sends a
// unique key with a request that changes a game. When it sends the request again with the same key, for
// example after a lost answer, the server sends the first answer again and changes nothing.
//
// Limit: the answers live in this process only, so a restart forgets them. A repeat after a restart
// runs again: a repeated move then gets 409 with the code "already-played", and a repeated chat
// message shows twice. Revisit this with more than one API process, or when restarts during play
// cause real duplicates.

// Keys have at most this many characters.
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
// The server keeps the answer of a key this long. A client retries within minutes, so an hour is plenty.
export const IDEMPOTENCY_TTL_MS = 3_600_000;

// The key from the header value. The draft makes the value a Structured Field String ("..."), and a
// bare key also works, because it is easier with curl. Undefined for a missing header; an error for a bad key.
export function parseIdempotencyKey(header: string | string[] | undefined): string | undefined | Error {
  if (header === undefined) return undefined;
  if (Array.isArray(header)) return new Error('Send one Idempotency-Key header.');
  const quoted = header.length >= 2 && header.startsWith('"') && header.endsWith('"');
  const key = quoted ? header.slice(1, -1) : header;
  const visible = [...key].every((char) => char >= '!' && char <= '~' && char !== '"' && char !== '\\');
  if (key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !visible) {
    return new Error(`An Idempotency-Key has 1 to ${IDEMPOTENCY_KEY_MAX_LENGTH} visible ASCII characters, without quotes or backslashes.`);
  }
  return key;
}

// The answer that a repeat gets.
export type StoredAnswer = { status: number; body: string; headers: Record<string, string | string[]> };

// What to do with a request that has a key:
// - run: a new key. Run the request and call `finish` with its answer, or `abandon` for a server error.
// - replay: a repeat. Send the stored answer.
// - mismatch: the key came before with another request. The draft answers 422.
// - running: the first request with the key still runs. The draft answers 409.
export type Claim =
  | { kind: 'run'; finish(answer: StoredAnswer): void; abandon(): void }
  | { kind: 'replay'; answer: StoredAnswer }
  | { kind: 'mismatch' }
  | { kind: 'running' };

type Entry = { request: string; answer: StoredAnswer | undefined; expiresAt: number };

// Keeps the answers of at most `max` keys, each for `ttlMs`. When full, it forgets the oldest key.
// `scope` keeps the keys of one player and one path apart. `request` identifies the request: the method,
// the path and the body. The same key with another `request` is a mismatch.
export function createIdempotency({ ttlMs, max }: { ttlMs: number; max: number }) {
  if (!(ttlMs > 0 && Number.isInteger(max) && max >= 1)) throw new RangeError('idempotency needs positive limits');
  const entries = new Map<string, Entry>();

  return {
    size: () => entries.size,

    claim(scope: string, key: string, request: string, now: number): Claim {
      const id = `${scope}\n${key}`;
      const found = entries.get(id);
      if (found !== undefined && found.expiresAt > now) {
        if (found.request !== request) return { kind: 'mismatch' };
        return found.answer === undefined ? { kind: 'running' } : { kind: 'replay', answer: found.answer };
      }
      entries.delete(id);
      const oldest = entries.size >= max ? entries.keys().next().value : undefined;
      if (oldest !== undefined) entries.delete(oldest);
      const entry: Entry = { request, answer: undefined, expiresAt: now + ttlMs };
      entries.set(id, entry);
      return {
        kind: 'run',
        finish(answer) {
          entry.answer = answer;
        },
        // The entry goes, so a retry runs the request again.
        abandon() {
          if (entries.get(id) === entry) entries.delete(id);
        },
      };
    },
  };
}
