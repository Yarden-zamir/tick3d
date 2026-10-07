// Report and block (Google Play's policy for user-generated content). A right-click, a long press, or
// the context-menu key (Shift+F10) on a chat message or a person opens a small menu.
// - Block hides the person's messages, and shows a generated name and picture in place of theirs.
//   The server keeps the list per player (it follows a GitHub login). This device keeps a copy, so
//   a game without a network still hides blocked people.
// - Report sends a reason and a note to the maintainers. A reported message stays hidden on this device.
import type { Person } from '../avatar.ts';
import { nameOf } from '../names.ts';
import { api, OnlineError } from '../online.ts';
import { type BlockedPerson, type ChatMessage, type PersonId, REPORT_REASONS, type SessionView, parseBlocks } from '../protocol.ts';
import { BLOCK_ICON, FLAG_ICON } from '../icons.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import {
  myGamesBlocked,
  myGamesBlockedBox,
  safetyActions,
  safetyBack,
  safetyBlock,
  safetyCancel,
  safetyMenu,
  safetyNote,
  safetyReport,
  safetyReportForm,
  safetyTitle,
} from './dom.ts';
import { showError, showToast } from './feedback.ts';
import { type PersonTarget, authorOf, personTarget, visibleMessages } from './person-mark.ts';

export { authorOf };
import { render } from './render.ts';
import { page } from './state.ts';

const LONG_PRESS_MS = 500;
// A finger that moves more than this many pixels scrolls the page, so it is not a long press.
const MOVE_LIMIT_PX = 10;
// The reported messages that this device keeps hidden. The chat keeps only its newest messages, so old keys are of no use.
const REPORTED_KEPT = 200;

function readStored<T>(key: string, parse: (value: unknown) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(JSON.parse(raw));
  } catch {
    // Storage is blocked or holds a broken value: start empty.
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is blocked: the list lasts for this visit only.
  }
}

let blocked: BlockedPerson[] = readStored(STORAGE_KEYS.blocks, (value) => parseBlocks({ blocked: value }), []);
let reported: string[] = readStored(
  STORAGE_KEYS.reported,
  (value) => (Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []),
  [],
);

const isBlocked = (person: PersonId | null): boolean => person !== null && blocked.some((entry) => entry.person === person);

// The messages that this screen shows: none from a blocked person, and none that this device reported.
export const visibleChat = (view: SessionView): ChatMessage[] =>
  visibleMessages(view, new Set(blocked.map((entry) => entry.person)), new Set(reported));

// A blocked person shows with a generated name and picture, made from the person id.
export const shownPerson = (person: PersonId | null, shown: Person): Person =>
  isBlocked(person) && person !== null ? { player: null, name: nameOf(person) } : shown;

// The person id of this screen in the view, or null.
export function ownPerson(view: SessionView): PersonId | null {
  if (view.you !== null) return view.people[view.you];
  return view.watchers.find((watcher) => watcher.id === view.youWatcher)?.person ?? null;
}

function setBlocked(list: BlockedPerson[]): void {
  blocked = list;
  writeStored(STORAGE_KEYS.blocks, list);
  renderBlockedList();
  render();
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

// The Blocked people section of My games, with an Unblock button for each.
export function renderBlockedList(): void {
  myGamesBlockedBox.hidden = blocked.length === 0;
  myGamesBlocked.replaceChildren(
    ...blocked.map((entry) => {
      const item = document.createElement('li');
      const name = document.createElement('b');
      name.textContent = entry.name;
      const unblock = document.createElement('button');
      unblock.type = 'button';
      unblock.className = 'btn btn-small';
      unblock.textContent = 'Unblock';
      unblock.addEventListener('click', () => void changeBlock(entry.person, entry.name, false));
      item.append(name, unblock);
      return item;
    }),
  );
}

async function changeBlock(person: PersonId, name: string, block: boolean): Promise<void> {
  try {
    setBlocked(block ? await api.block(person, name) : await api.unblock(person));
    showToast(block ? `${name} is blocked. Unblock them in My games.` : `${name} is unblocked.`);
  } catch (error) {
    showError(error);
  }
}

// ---- The menu ----

let open: PersonTarget | undefined;

function openMenu(target: PersonTarget): void {
  const session = page.session;
  if (session === undefined || safetyMenu.open || target.person === ownPerson(session)) return;
  open = target;
  safetyTitle.textContent = target.message === null ? target.name : `A message from ${target.name}`;
  // The server holds online sessions only, so it cannot check a report from a Nearby game.
  safetyReport.hidden = session.mode !== 'online';
  safetyBlock.lastChild?.replaceWith(isBlocked(target.person) ? 'Unblock' : 'Block');
  safetyActions.hidden = false;
  safetyReportForm.hidden = true;
  safetyReportForm.reset();
  safetyMenu.showModal();
  (safetyReport.hidden ? safetyBlock : safetyReport).focus();
}

async function sendReport(target: PersonTarget, code: SessionView['code']): Promise<void> {
  const reason = REPORT_REASONS.find((option) => option === new FormData(safetyReportForm).get('reason'));
  if (reason === undefined) return;
  const note = safetyNote.value.trim();
  const about = target.message === null ? { person: target.person } : { message: target.message };
  try {
    await api.report({ code, reason, note, ...about });
  } catch (error) {
    showError(error);
    return;
  }
  safetyMenu.close();
  if (target.message !== null) {
    reported = [...reported, `${code}:${target.message}`].slice(-REPORTED_KEPT);
    writeStored(STORAGE_KEYS.reported, reported);
    render();
  }
  showToast('Thanks. The report went to the maintainers.');
}

export function setupSafety(): void {
  safetyReport.insertAdjacentHTML('afterbegin', FLAG_ICON);
  safetyBlock.insertAdjacentHTML('afterbegin', BLOCK_ICON);
  safetyCancel.addEventListener('click', () => safetyMenu.close());
  safetyMenu.addEventListener('click', (event) => {
    if (event.target === safetyMenu) safetyMenu.close();
  });
  safetyReport.addEventListener('click', () => {
    safetyActions.hidden = true;
    safetyReportForm.hidden = false;
    safetyReportForm.querySelector<HTMLInputElement>('input[name="reason"]')?.focus();
  });
  safetyBack.addEventListener('click', () => {
    safetyReportForm.hidden = true;
    safetyActions.hidden = false;
    safetyReport.focus();
  });
  safetyBlock.addEventListener('click', () => {
    const target = open;
    if (target === undefined) return;
    safetyMenu.close();
    void changeBlock(target.person, target.name, !isBlocked(target.person));
  });
  safetyReportForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const target = open;
    const code = page.session?.code;
    if (target !== undefined && code !== undefined) void sendReport(target, code);
  });

  // A right-click, and on most browsers the context-menu key and Shift+F10 too.
  document.addEventListener('contextmenu', (event) => {
    const found = personTarget(event.target);
    if (found === undefined) return;
    event.preventDefault();
    openMenu(found.target);
  });
  // Some browsers send no contextmenu event for the keyboard.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    const found = personTarget(document.activeElement);
    if (found === undefined) return;
    event.preventDefault();
    openMenu(found.target);
  });

  // A long press with touch or a pen. iOS sends no contextmenu event, so the press needs its own timer.
  // The click that ends the press is dropped, so it does not also act on the element.
  let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined;
  let dropClick = false;
  const endPress = () => {
    if (press !== undefined) clearTimeout(press.timer);
    press = undefined;
  };
  document.addEventListener('pointerdown', (event) => {
    endPress();
    dropClick = false;
    const found = personTarget(event.target);
    if (event.pointerType === 'mouse' || found === undefined) return;
    const timer = setTimeout(() => {
      dropClick = true;
      openMenu(found.target);
    }, LONG_PRESS_MS);
    press = { x: event.clientX, y: event.clientY, timer };
  });
  document.addEventListener('pointermove', (event) => {
    if (press !== undefined && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_LIMIT_PX) endPress();
  });
  document.addEventListener('pointerup', endPress);
  document.addEventListener('pointercancel', endPress);
  document.addEventListener(
    'click',
    (event) => {
      if (!dropClick) return;
      dropClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );
}
