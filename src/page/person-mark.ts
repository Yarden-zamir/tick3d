// The marks on a page element that stands for a person: a chat message, a seat, a watcher or a score.
// A right-click, a long press or the context-menu key on it opens the report and block menu (src/page/safety.ts).
// This module has no page elements, so the chat log stays testable.
import { type ChatMessage, type PersonId, type SessionView, parsePersonId } from '../protocol.ts';

// `name` is the name that the page shows. `message` is the chat message id, for a message.
export type PersonTarget = { person: PersonId; name: string; message: number | null };

export function markPerson(element: HTMLElement, target: PersonTarget): void {
  element.dataset.person = target.person;
  element.dataset.personName = target.name;
  if (target.message !== null) element.dataset.message = String(target.message);
  // Keyboard users reach it with Tab, then open the menu with the context-menu key or Shift+F10.
  if (element.tabIndex < 0) element.tabIndex = 0;
}

// The target of an element inside a marked element, or undefined.
export function personTarget(element: EventTarget | null): { element: HTMLElement; target: PersonTarget } | undefined {
  const marked = element instanceof Element ? element.closest<HTMLElement>('[data-person]') : null;
  if (marked === null) return undefined;
  const person = parsePersonId(marked.dataset.person);
  const name = marked.dataset.personName;
  if (person === undefined || name === undefined) throw new Error('a person mark is broken');
  const message = marked.dataset.message === undefined ? null : Number(marked.dataset.message);
  return { element: marked, target: { person, name, message } };
}

// The author of a message. A message from before person ids has no `by`: it shows with the player who
// holds its seat now. Limit: after a seat change such an old message shows with the new holder. Only
// stored messages from before person ids have no `by`, and the chat keeps only the newest ones.
export const authorOf = (view: SessionView, message: ChatMessage): PersonId | null =>
  message.by ?? (message.from === 'watcher' ? null : view.people[message.from]);

// The messages to show: none from a blocked person, and none whose "<code>:<id>" this device reported.
export const visibleMessages = (view: SessionView, blocked: ReadonlySet<PersonId>, reported: ReadonlySet<string>): ChatMessage[] =>
  view.chat.filter((message) => {
    const author = authorOf(view, message);
    return !(author !== null && blocked.has(author)) && !reported.has(`${view.code}:${message.id}`);
  });
