// The chat with the other player in a game with another device.
import { other } from '../game.ts';
import { type ChatMessage, normalizeChat } from '../protocol.ts';
import { sounds } from '../sound.ts';
import { chatEl, chatInput, chatSend, chatLog, chatNoticeFrom, chatNoticeText, chatNotice, chatForm } from './dom.ts';
import { reject, showToast, showError } from './feedback.ts';
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

export function renderChat(): void {
  chatEl.hidden = !shared();
  if (page.session === undefined || !shared()) {
    chatShown = '';
    return;
  }
  const canWrite = page.session.you !== null;
  chatInput.disabled = !canWrite;
  chatSend.disabled = !canWrite || chatSending;
  const you = page.session.you;
  chatInput.placeholder = you === null ? 'Only the two players can chat' : `Message ${playerName(other(you))}`;

  const shown = `${page.session.code}:${page.session.chat.map((message) => message.id).join(',')}`;
  if (shown === chatShown) return;
  chatShown = shown;
  if (page.session.chat.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'chat-empty';
    empty.textContent = canWrite ? 'No messages yet. Say hi.' : 'No messages yet.';
    chatLog.replaceChildren(empty);
    return;
  }
  chatLog.replaceChildren(
    ...page.session.chat.map((message) => {
      const item = document.createElement('li');
      item.className = `chat-message from-${message.from.toLowerCase()}`;
      item.classList.toggle('mine', message.from === page.session?.you);
      const name = document.createElement('b');
      name.textContent = playerName(message.from);
      const text = document.createElement('span');
      text.dir = 'auto'; // Hebrew and Arabic messages read right to left
      text.textContent = message.text;
      item.append(name, text);
      return item;
    }),
  );
  chatLog.scrollTop = chatLog.scrollHeight;
}

// True when the whole chat box is on screen, so the player sees new messages arrive.
function chatInView(): boolean {
  if (chatEl.hidden || document.hidden) return false;
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
  chatNoticeFrom.textContent = playerName(message.from);
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
