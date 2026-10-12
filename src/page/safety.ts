// Report and block (the Apple and Google Play rules for user content) on the game page. A right-click, a
// long press, or the context-menu key (Shift+F10) on a chat message or a person opens the dialog of
// src/safety-dialog.ts.
// - Block hides the person's messages, and shows a generated name and picture in place of theirs.
//   src/blocks.ts keeps the list.
// - Report sends a reason and a note to the maintainers. A reported message stays hidden on this device.
import type { Person } from '../avatar.ts';
import { blockedPeople, changeBlock, isBlocked, loadBlocks, onBlocksChange, readStored, writeStored } from '../blocks.ts';
import { nameOf } from '../names.ts';
import { api } from '../online.ts';
import type { ChatEntry, PersonId, ReportReason, SessionView } from '../protocol.ts';
import { openSafetyDialog, safetyDialogOpen } from '../safety-dialog.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import { myGamesBlocked, myGamesBlockedBox } from './dom.ts';
import { showError, showToast } from './feedback.ts';
import { type PersonTarget, authorOf, personTarget, visibleMessages } from './person-mark.ts';

export { authorOf, loadBlocks };
import { render } from './render.ts';
import { page } from './state.ts';

const LONG_PRESS_MS = 500;
// A finger that moves more than this many pixels scrolls the page, so it is not a long press.
const MOVE_LIMIT_PX = 10;
// The reported messages that this device keeps hidden. The chat keeps only its newest messages, so old keys are of no use.
const REPORTED_KEPT = 200;

let reported: string[] = readStored(
  STORAGE_KEYS.reported,
  (value) => (Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []),
  [],
);

// The messages that this screen shows: none from a blocked person, and none that this device reported.
export const visibleChat = (view: SessionView): ChatEntry[] =>
  visibleMessages(view, new Set(blockedPeople().map((entry) => entry.person)), new Set(reported));

// A blocked person shows with a generated name and picture, made from the person id.
export const shownPerson = (person: PersonId | null, shown: Person): Person =>
  isBlocked(person) && person !== null ? { player: null, name: nameOf(person) } : shown;

// The person id of this screen in the view, or null.
export function ownPerson(view: SessionView): PersonId | null {
  if (view.you !== null) return view.people[view.you];
  return view.watchers.find((watcher) => watcher.id === view.youWatcher)?.person ?? null;
}

// The Blocked people section of My games, with an Unblock button for each.
export function renderBlockedList(): void {
  const blocked = blockedPeople();
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
      unblock.addEventListener('click', () => void toggleBlock(entry.person, entry.name, false));
      item.append(name, unblock);
      return item;
    }),
  );
}

async function toggleBlock(person: PersonId, name: string, block: boolean): Promise<void> {
  try {
    showToast(await changeBlock(person, name, block));
  } catch (error) {
    showError(error);
  }
}

// ---- The menu ----

function openMenu(target: PersonTarget): void {
  const session = page.session;
  if (session === undefined || safetyDialogOpen() || target.person === ownPerson(session)) return;
  const { code } = session;
  openSafetyDialog({
    title: target.message === null ? target.name : `A message from ${target.name}`,
    // The server holds online sessions only, so it cannot check a report from a Nearby game.
    canReport: session.mode === 'online',
    blocked: isBlocked(target.person),
    toggleBlock: () => void toggleBlock(target.person, target.name, !isBlocked(target.person)),
    report: (reason, note) => sendReport(target, code, reason, note),
  });
}

async function sendReport(target: PersonTarget, code: SessionView['code'], reason: ReportReason, note: string): Promise<boolean> {
  const about = target.message === null ? { person: target.person } : { message: target.message };
  try {
    await api.report({ code, reason, note, ...about });
  } catch (error) {
    showError(error);
    return false;
  }
  if (target.message !== null) {
    reported = [...reported, `${code}:${target.message}`].slice(-REPORTED_KEPT);
    writeStored(STORAGE_KEYS.reported, reported);
    render();
  }
  showToast('Thanks. The report went to the maintainers.');
  return true;
}

export function setupSafety(): void {
  onBlocksChange(() => {
    renderBlockedList();
    render();
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
