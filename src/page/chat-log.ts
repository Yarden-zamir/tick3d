// The items of the chat log. Messages in a row from one sender form one group: one picture and one
// name, then the bubbles. This module has no page elements, so a unit test can build the log.
import { avatarFor, type Person } from '../avatar.ts';
import { describeClock } from '../clock.ts';
import { type ChatEntry, type ChatMessage, type PersonId, type SessionEvent, isChatEvent } from '../protocol.ts';
import { markPerson } from './person-mark.ts';

const AVATAR_PIXELS = 28;

// `label` is the name over the bubbles ("You" for this screen's player). `person` gives the picture.
// `id` is the person id of the sender (null for an unknown sender), and `mine` marks this screen's messages.
export type Sender = { label: string; person: Person; id: PersonId | null; mine: boolean };

// One group per run of messages from one sender: the person id, else the seat at send time.
const senderKey = (message: ChatMessage, sender: Sender) => sender.id ?? `seat:${message.from}`;

const OPTION_LABELS = { hideBoard: 'Hide board', hideHistory: 'Hide history', hideCoordinates: 'Hide coordinates' } as const;
const SEAT_TEXTS: Record<Extract<SessionEvent, { kind: 'seat' }>['action'], string> = {
  swap: 'X and O swapped.',
  leave: 'A player left their seat.',
  give: 'A player gave their seat to a watcher.',
  seat: 'A watcher took the empty seat.',
  unseat: 'A player moved to the watchers.',
  replace: 'A watcher took a seat.',
  undo: 'A move went back.',
};

// The line of an event in the chat log. The toasts of the same changes use it too.
export function eventText(event: SessionEvent): string {
  switch (event.kind) {
    case 'new-game':
      return `Game ${event.game} started.${event.swapped ? ' X and O swapped.' : ''}`;
    case 'option':
      return `${OPTION_LABELS[event.option]} is ${event.on ? 'on' : 'off'} for both players.`;
    case 'fixed-seats':
      return event.on ? 'Seats kept.' : 'Seats swap each game.';
    case 'watcher-chat':
      return event.on ? 'Watchers can chat.' : 'Only the players can chat.';
    case 'clock':
      return `Time limit: ${describeClock(event.clock)}.`;
    case 'name':
      return `Renamed to ${event.name}.`;
    case 'lock':
      return 'Settings are locked for both players until this game ends.';
    case 'seat':
      return SEAT_TEXTS[event.action];
  }
}

type Group = { kind: 'messages'; sender: Sender; key: string; messages: ChatMessage[] } | { kind: 'event'; event: SessionEvent };

// An event ends the group before it, so messages around it never merge.
export function chatGroups(entries: readonly ChatEntry[], senderOf: (message: ChatMessage) => Sender): HTMLLIElement[] {
  const groups: Group[] = [];
  for (const entry of entries) {
    if (isChatEvent(entry)) {
      groups.push({ kind: 'event', event: entry.event });
      continue;
    }
    const sender = senderOf(entry);
    const key = senderKey(entry, sender);
    const last = groups.at(-1);
    if (last?.kind === 'messages' && last.key === key) last.messages.push(entry);
    else groups.push({ kind: 'messages', sender, key, messages: [entry] });
  }
  return groups.map((group) => (group.kind === 'event' ? eventItem(group.event) : messageGroup(group.sender, group.messages)));
}

function eventItem(event: SessionEvent): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'chat-event';
  item.textContent = eventText(event);
  return item;
}

function messageGroup(sender: Sender, group: readonly ChatMessage[]): HTMLLIElement {
  const first = group[0];
  if (first === undefined) throw new Error('a chat group is empty');
  const item = document.createElement('li');
  // The color is the seat at send time. A watcher has none.
  item.className = `chat-group from-${first.from.toLowerCase()}`;
  item.classList.toggle('mine', sender.mine);
  const body = document.createElement('div');
  body.className = 'chat-group-body';
  const name = document.createElement('b');
  name.textContent = sender.label;
  body.append(name);
  for (const message of group) {
    const text = document.createElement('span');
    text.className = 'chat-message';
    text.dir = 'auto'; // Hebrew and Arabic messages read right to left
    text.textContent = message.text;
    // Another player's message opens the report and block menu (src/page/safety.ts).
    if (!sender.mine && sender.id !== null) markPerson(text, { person: sender.id, name: sender.person.name, message: message.id });
    body.append(text);
  }
  // A click on the picture opens it large. A long press on another player's picture opens the menu too.
  const avatar = avatarFor(sender.person, AVATAR_PIXELS, sender.id);
  if (!sender.mine && sender.id !== null) markPerson(avatar, { person: sender.id, name: sender.person.name, message: null });
  item.append(avatar, body);
  return item;
}
