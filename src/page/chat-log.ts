// The items of the chat log. Messages in a row from one sender form one group: one picture and one
// name, then the bubbles. This module has no page elements, so a unit test can build the log.
import { avatarFor, type Person } from '../avatar.ts';
import type { ChatMessage, PersonId } from '../protocol.ts';
import { markPerson } from './person-mark.ts';

const AVATAR_PIXELS = 28;

// `label` is the name over the bubbles ("You" for this screen's player). `person` gives the picture.
// `id` is the person id of the sender (null for an unknown sender), and `mine` marks this screen's messages.
export type Sender = { label: string; person: Person; id: PersonId | null; mine: boolean };

// One group per run of messages from one sender: the person id, else the seat at send time.
const senderKey = (message: ChatMessage, sender: Sender) => sender.id ?? `seat:${message.from}`;

export function chatGroups(messages: readonly ChatMessage[], senderOf: (message: ChatMessage) => Sender): HTMLLIElement[] {
  const groups: { sender: Sender; key: string; messages: ChatMessage[] }[] = [];
  for (const message of messages) {
    const sender = senderOf(message);
    const key = senderKey(message, sender);
    const last = groups.at(-1);
    if (last?.key === key) last.messages.push(message);
    else groups.push({ sender, key, messages: [message] });
  }
  return groups.map(({ sender, messages: group }) => {
    const first = group[0];
    if (first === undefined) throw new Error('a chat group is empty');
    const item = document.createElement('li');
    // The color is the seat at send time.
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
  });
}
