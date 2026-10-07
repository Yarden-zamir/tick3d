// Storage on this device, in IndexedDB. Every session ever played on the device stays here:
// there is no limit until storage use calls for one.
import { epochNow, isEpochMs } from './epoch.ts';
import { isCount, isRecord, keysOf } from './guards.ts';
import { type Code, type ResultUpload, type SessionView, normalizeCode, parseResultUpload, parseSessionView } from './protocol.ts';

// A session that this device holds: computer and friend games, and Nearby games it hosts.
// `doc` is the stored document, read through parseDoc on every load like on the server.
export type DeviceSession = { code: Code; doc: unknown; version: number; updatedAt: number };
// A finished game waiting for upload, or already sent.
type DeviceResult = { id: string; upload: ResultUpload; sent: boolean };
// The last view of an online session, so it opens read-only without a network.
type CachedView = { code: Code; view: SessionView; savedAt: number };

type Stores = { sessions: DeviceSession; results: DeviceResult; remote: CachedView };
type StoreName = keyof Stores;

const DB_NAME = 'tick3d';
// Version 1 creates the stores. To add a store or an index, raise the version and add a step
// in onupgradeneeded. Never change a step that a released version already ran.
const DB_VERSION = 1;
// The key path of each store: a field of its rows, so a renamed field breaks the build.
const KEYS: { readonly [S in StoreName]: keyof Stores[S] & string } = { sessions: 'code', results: 'id', remote: 'code' };

// A stored code must already be in its normal form: it is the key of its row.
function storedCode(value: unknown): Code | undefined {
  if (typeof value !== 'string') return undefined;
  const code = normalizeCode(value);
  return code === value ? code : undefined;
}

// IndexedDB gives back any. Each store reads its rows through one parser, so a row from an older version,
// another tab or a hand edit cannot reach the game with the wrong shape. A parser throws on a bad row.
const PARSERS: { readonly [S in StoreName]: (row: unknown) => Stores[S] } = {
  sessions(row) {
    if (!isRecord(row)) throw new Error('stored session: not an object');
    const { code, doc, version, updatedAt } = row;
    const checked = storedCode(code);
    if (checked === undefined || !isCount(version) || !isEpochMs(updatedAt)) throw new Error('stored session: bad code, version or time');
    // local.ts parses the document itself, so one damaged document stays visible on its own row.
    return { code: checked, doc, version, updatedAt };
  },
  results(row) {
    if (!isRecord(row)) throw new Error('stored result: not an object');
    const { id, sent } = row;
    const upload = parseResultUpload(row.upload, epochNow());
    if (typeof id !== 'string' || typeof sent !== 'boolean' || upload === undefined) throw new Error('stored result: bad id, sent flag or upload');
    return { id, upload, sent };
  },
  remote(row) {
    if (!isRecord(row)) throw new Error('stored view: not an object');
    const { code, savedAt } = row;
    const checked = storedCode(code);
    if (checked === undefined || !isEpochMs(savedAt)) throw new Error('stored view: bad code or time');
    return { code: checked, view: parseSessionView(row.view), savedAt };
  },
};

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export type DeviceDb = {
  get<S extends StoreName>(store: S, key: string): Promise<Stores[S] | undefined>;
  put<S extends StoreName>(store: S, value: Stores[S]): Promise<void>;
  all<S extends StoreName>(store: S): Promise<Stores[S][]>;
  delete(store: StoreName, key: string): Promise<void>;
};

export async function openDeviceDb(factory: IDBFactory = indexedDB, name: string = DB_NAME): Promise<DeviceDb> {
  const open = factory.open(name, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    for (const store of keysOf(KEYS)) {
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: KEYS[store] });
    }
  };
  // Another tab holds the database open at an older version and does not close it.
  const blocked = new Promise<never>((_, reject) => {
    open.onblocked = () => reject(new Error('Another tick3d tab uses an older version of the game. Close that tab and reload.'));
  });
  const db = await Promise.race([request(open), blocked]);
  // A newer version in another tab needs this connection closed before it can upgrade.
  db.onversionchange = () => db.close();
  // Ask the browser to keep this data under storage pressure. Safari still clears it after
  // 7 days without a visit, unless the game is added to the home screen.
  void navigator.storage?.persist?.().catch(() => false);

  const store = (name: StoreName, mode: IDBTransactionMode) => db.transaction(name, mode).objectStore(name);
  return {
    // Throws when the row does not parse, like opening a damaged session.
    async get(name, key) {
      const row: unknown = await request(store(name, 'readonly').get(key));
      return row === undefined ? undefined : PARSERS[name](row);
    },
    async put(name, value) {
      await request(store(name, 'readwrite').put(value));
    },
    // Leaves out the rows that do not parse, like the list of sessions, so one damaged row cannot hide the others.
    async all(name) {
      const rows: unknown[] = await request(store(name, 'readonly').getAll());
      const parsed: Stores[typeof name][] = [];
      for (const row of rows) {
        try {
          parsed.push(PARSERS[name](row));
        } catch (error) {
          console.warn(`A row in the ${name} store on this device does not parse:`, error);
        }
      }
      return parsed;
    },
    async delete(name, key) {
      await request(store(name, 'readwrite').delete(key));
    },
  };
}

// Storage for one visit only, for a browser that blocks IndexedDB (some private modes).
export function memoryDeviceDb(): DeviceDb {
  const stores: { [S in StoreName]: Map<string, Stores[S]> } = { sessions: new Map(), results: new Map(), remote: new Map() };
  const keyOf = <S extends StoreName>(name: S, value: Stores[S]): string => String(value[KEYS[name]]);
  return {
    async get(name, key) {
      return structuredClone(stores[name].get(key));
    },
    async put(name, value) {
      (stores[name] as Map<string, typeof value>).set(keyOf(name, value), structuredClone(value));
    },
    async all(name) {
      return [...stores[name].values()].map((value) => structuredClone(value));
    },
    async delete(name, key) {
      stores[name].delete(key);
    },
  };
}
