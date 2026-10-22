// The people that this player blocked, for the game page and the stats page. The server keeps the list
// per player (it follows a GitHub login). This device keeps a copy, so a page without a network still
// hides blocked people.
import { api, OnlineError } from './online.ts';
import { type BlockedPerson, type PersonId, parseBlocks } from './protocol.ts';
import { STORAGE_KEYS } from './storage-keys.ts';

export function readStored<T>(key: string, parse: (value: unknown) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(JSON.parse(raw));
  } catch {
    // Storage is blocked or holds a broken value: start empty.
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is blocked: the list lasts for this visit only.
  }
}

let blocked: BlockedPerson[] = readStored(STORAGE_KEYS.blocks, (value) => parseBlocks({ blocked: value }), []);
const listeners = new Set<() => void>();

export const blockedPeople = (): readonly BlockedPerson[] => blocked;
export const isBlocked = (person: PersonId | null): boolean => person !== null && blocked.some((entry) => entry.person === person);

// `listener` runs after each change of the list.
export function onBlocksChange(listener: () => void): void {
  listeners.add(listener);
}

function setBlocked(list: BlockedPerson[]): void {
  blocked = list;
  writeStored(STORAGE_KEYS.blocks, list);
  for (const listener of listeners) listener();
}

// Reads the block list of this player from the server. Without a network the page keeps its copy.
export async function loadBlocks(): Promise<void> {
  if (!navigator.onLine) return;
  try {
    setBlocked(await api.blocks());
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
  }
}

// Blocks or unblocks a person, and answers the text that tells the player. Throws when the server refuses.
export async function changeBlock(person: PersonId, name: string, block: boolean): Promise<string> {
  setBlocked(block ? await api.block(person, name) : await api.unblock(person));
  return block ? `${name} is blocked. Unblock them in My games.` : `${name} is unblocked.`;
}
