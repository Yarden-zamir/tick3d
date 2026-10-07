// The items of the chat log. Messages in a row from one sender form one group: one picture and one
// name, then the bubbles. This module has no page elements, so a unit test can build the log.
import { avatarFor, type Person } from '../avatar.ts';
import type { Player } from '../game.ts';
import type { ChatMessage } from '../protocol.ts';

const AVATAR_PIXELS = 28;

// `label` is the name over the bubbles ("You" for this screen's seat). `person` gives the picture.
export type Sender = { label: string; person: Person };

export function chatGroups(messages: readonly ChatMessage[], senderOf: (seat: Player) => Sender, you: Player | null): HTMLLIElement[] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    const last = groups.at(-1);
    if (last?.[0]?.from === message.from) last.push(message);
    else groups.push([message]);
  }
  return groups.map((group) => {
    const from = group[0]?.from;
    if (from === undefined) throw new Error('a chat group is empty');
    const sender = senderOf(from);
    const item = document.createElement('li');
    item.className = `chat-group from-${from.toLowerCase()}`;
    item.classList.toggle('mine', from === you);
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
      body.append(text);
    }
    item.append(avatarFor(sender.person, AVATAR_PIXELS), body);
    return item;
  });
}
