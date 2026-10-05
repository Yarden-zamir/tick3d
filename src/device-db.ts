// Storage on this device, in IndexedDB. Every session ever played on the device stays here:
// there is no limit until storage use calls for one.
import type { Code, ResultUpload, SessionView } from './protocol.ts';

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
const KEYS: Record<StoreName, string> = { sessions: 'code', results: 'id', remote: 'code' };

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
};

export async function openDeviceDb(factory: IDBFactory = indexedDB, name: string = DB_NAME): Promise<DeviceDb> {
  const open = factory.open(name, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    for (const store of Object.keys(KEYS) as StoreName[]) {
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
    async get(name, key) {
      return (await request(store(name, 'readonly').get(key))) as never;
    },
    async put(name, value) {
      await request(store(name, 'readwrite').put(value));
    },
    async all(name) {
      return (await request(store(name, 'readonly').getAll())) as never;
    },
  };
}

// Storage for one visit only, for a browser that blocks IndexedDB (some private modes).
export function memoryDeviceDb(): DeviceDb {
  const stores: { [S in StoreName]: Map<string, Stores[S]> } = { sessions: new Map(), results: new Map(), remote: new Map() };
  const keyOf = <S extends StoreName>(name: S, value: Stores[S]): string => String((value as Record<string, unknown>)[KEYS[name]]);
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
  };
}
