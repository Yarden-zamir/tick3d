// The chat with the other player in a game with another device.
import { other } from '../game.ts';
import { type ChatMessage, type SessionView, normalizeChat } from '../protocol.ts';
import { sounds } from '../sound.ts';
import { chatEl, chatInput, chatSend, chatLog, chatNoticeFrom, chatNoticeText, chatNotice, chatForm } from './dom.ts';
import { type Sender, chatGroups } from './chat-log.ts';
import { nameOf } from '../names.ts';
import { authorOf, ownPerson, shownPerson, visibleChat } from './safety.ts';
import { reject, showToast, showError } from './feedback.ts';
import { seatPerson } from './players.ts';
import { playerName, render } from './render.ts';
import { applyView } from './sessions.ts';
import { shared, page } from './state.ts';

// Chat sends do not use `page.busy`, so a message never blocks a move.
let chatSending = false;
// What the chat log shows, so a render rebuilds it (and scrolls it) only when messages change.
let chatShown = '';
let chatNoticeTimer: ReturnType<typeof setTimeout> | undefined;
// Messages from the other player that arrived while this tab was in the background.
let unread = 0;
const baseTitle = document.title;

// The sender of a message, by its person id. A message without one shows with the holder of its seat.
function senderOf(session: SessionView, message: ChatMessage): Sender {
  const id = authorOf(session, message);
  const mine = id === null ? message.from === session.you : id === ownPerson(session);
  const seat = id === null ? message.from : (['X', 'O'] as const).find((entry) => session.people[entry] === id);
  const watcher = session.watchers.find((entry) => entry.person !== null && entry.person === id);
  // An author who left the game shows with the generated name of the person id.
  const person =
    seat !== undefined
      ? seatPerson(session, seat)
      : shownPerson(id, watcher === undefined ? { player: null, name: nameOf(id ?? message.from) } : { player: watcher.player, name: watcher.player?.login ?? watcher.name });
  return { label: mine ? 'You' : person.name, person, id, mine };
}

// The log key of the closed chat: a game on this device, or no game yet.
const CLOSED = 'closed';

export function renderChat(): void {
  // A wide screen keeps the closed chat in its column, so nothing moves when it opens (src/style.css .chat.closed).
  const open = page.session !== undefined && shared();
  chatEl.classList.toggle('closed', !open);
  if (page.session === undefined || !open) {
    chatInput.disabled = true;
    chatSend.disabled = true;
    chatInput.placeholder = 'Message';
    if (chatShown === CLOSED) return;
    chatShown = CLOSED;
    chatLog.replaceChildren();
    return;
  }
  const canWrite = page.session.you !== null;
  chatInput.disabled = !canWrite;
  chatSend.disabled = !canWrite || chatSending;
  const you = page.session.you;
  chatInput.placeholder = you === null ? 'Only the two players can chat' : `Message ${playerName(other(you))}`;

  const session = page.session;
  const messages = visibleChat(session);
  // A block changes the shown names, so the key holds the shown sender of every message.
  const shown = `${session.code}:${messages.map((message) => `${message.id}:${senderOf(session, message).label}`).join(',')}`;
  if (shown === chatShown) return;
  chatShown = shown;
  if (messages.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'chat-empty';
    empty.textContent = canWrite ? 'No messages yet. Say hi.' : 'No messages yet.';
    chatLog.replaceChildren(empty);
    return;
  }
  chatLog.replaceChildren(...chatGroups(messages, (message) => senderOf(session, message)));
  chatLog.scrollTop = chatLog.scrollHeight;
}

// True when the whole chat box is on screen, so the player sees new messages arrive.
function chatInView(): boolean {
  if (chatEl.classList.contains('closed') || document.hidden) return false;
  const box = chatEl.getBoundingClientRect();
  return box.top >= 0 && box.bottom <= innerHeight;
}

// A bar at the top of the screen with the newest message, unless the chat is already in view.
// In a background tab, the page title also counts unread messages.
export function notifyChat(message: ChatMessage, count: number): void {
  if (document.hidden) {
    unread += count;
    document.title = `(${unread}) ${baseTitle}`;
  }
  if (chatInView()) return;
  if (page.session !== undefined) chatNoticeFrom.textContent = senderOf(page.session, message).label;
  chatNoticeText.textContent = message.text;
  chatNotice.classList.toggle('from-x', message.from === 'X');
  chatNotice.classList.toggle('from-o', message.from === 'O');
  chatNotice.hidden = false;
  clearTimeout(chatNoticeTimer);
  chatNoticeTimer = setTimeout(hideChatNotice, 6000);
}

function hideChatNotice(): void {
  clearTimeout(chatNoticeTimer);
  chatNotice.hidden = true;
}

export function setupChat(): void {
  chatNotice.addEventListener('click', () => {
    hideChatNotice();
    chatEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (page.session?.you != null) chatInput.focus({ preventScroll: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    unread = 0;
    document.title = baseTitle;
  });

  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (page.session === undefined || !shared() || chatSending) return;
    if (page.session.you === null) return reject(undefined, 'spectator');
    const text = normalizeChat(chatInput.value);
    if (text === undefined) {
      sounds.invalid();
      showToast('Type a message first.');
      return;
    }
    const { code, backend } = page.session;
    const typed = chatInput.value;
    chatSending = true;
    render();
    void (async () => {
      try {
        const view = await backend.chat(code, text);
        // A message typed during the send stays in the box.
        if (chatInput.value === typed) chatInput.value = '';
        sounds.sent();
        if (page.session?.code === code) applyView(view);
      } catch (error) {
        showError(error);
      } finally {
        chatSending = false;
        render();
      }
    })();
  });
}
