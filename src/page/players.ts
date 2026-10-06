// The Players box of a game with another device: the seats, the watchers, and the seat controls.
// The session rules (seat and answerSeat in src/session/core.ts) decide; this module only asks.
// A change of the other player's seat waits for that player: they get a prompt to accept or decline.
import { type Player, other } from '../game.ts';
import type { ConsentAction, SeatAction, SeatRequestView, SessionView } from '../protocol.ts';
import { EYE_ICON } from '../icons.ts';
import { sounds } from '../sound.ts';
import {
  playersList,
  playersRequest,
  playersRequestActions,
  playersRequestText,
  seatPrompt,
  seatPromptAccept,
  seatPromptDecline,
  seatPromptText,
} from './dom.ts';
import { showToast } from './feedback.ts';
import { applyView, refresh, withBusy } from './sessions.ts';
import { nowMs, page, shared } from './state.ts';

// The name of the player on a seat as everybody sees it, without "You".
function seatHolder(view: SessionView, seat: Player): string | null {
  if (!view.seats[seat]) return null;
  return view.players[seat]?.login ?? view.names[seat] ?? `Player ${seat}`;
}

function requestText(request: SeatRequestView, asker: string): string {
  const texts: Record<ConsentAction, string> = {
    swap: `${asker} wants to swap X and O.`,
    unseat: `${asker} wants you to watch instead. Your seat then empties.`,
    replace: `${asker} wants ${request.watcher?.player?.login ?? request.watcher?.name ?? 'a watcher'} to take your seat. You then watch.`,
  };
  return texts[request.kind];
}

const WAIT_TEXT: Record<ConsentAction, string> = { swap: 'the swap', unseat: 'the move to watching', replace: 'the new player' };

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.className = primary ? 'btn btn-small btn-primary' : 'btn btn-small';
  element.disabled = page.busy;
  element.addEventListener('click', onClick);
  return element;
}

function act(action: SeatAction, done: string): void {
  const session = page.session;
  if (session === undefined) return;
  sounds.click();
  void withBusy(async () => {
    applyView(await session.backend.seat(session.code, action));
    showToast(page.session?.seatRequest ? 'Request sent. The other player must accept it.' : done);
  });
}

function answer(accept: boolean): void {
  const session = page.session;
  if (session === undefined) return;
  sounds.click();
  seatPrompt.close();
  void withBusy(async () => {
    applyView(await session.backend.answerSeat(session.code, accept));
    showToast(accept ? 'Accepted. The seats changed.' : session.seatRequest?.from === session.you ? 'Request cancelled.' : 'Declined.');
  });
}

function row(mark: Player | 'watcher', name: string, note: string, actions: HTMLButtonElement[]): HTMLLIElement {
  const item = document.createElement('li');
  const markEl = document.createElement('span');
  markEl.className = `players-mark ${mark.toLowerCase()}`;
  if (mark === 'watcher') markEl.innerHTML = EYE_ICON;
  else markEl.textContent = mark;
  markEl.setAttribute('aria-hidden', 'true');
  const nameEl = document.createElement('b');
  nameEl.className = 'players-name';
  nameEl.textContent = name;
  const noteEl = document.createElement('small');
  noteEl.className = 'players-note';
  noteEl.textContent = note;
  const actionsEl = document.createElement('div');
  actionsEl.className = 'players-row-actions';
  actionsEl.append(...actions);
  item.append(markEl, nameEl, noteEl, actionsEl);
  return item;
}

// The request that this screen last showed in the prompt, so a closed prompt does not open again.
let prompted: number | undefined;
// A refresh when the open request ends, so every screen drops it without a server push.
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function renderRequest(view: SessionView): void {
  const request = view.seatRequest;
  const you = view.you;
  clearTimeout(expiryTimer);
  if (request === null || you === null) {
    playersRequest.hidden = true;
    if (seatPrompt.open) seatPrompt.close();
    return;
  }
  const code = view.code;
  expiryTimer = setTimeout(() => void refresh(code), Math.max(0, request.expiresAt - nowMs()) + 500);
  playersRequest.hidden = false;
  const otherName = seatHolder(view, other(you)) ?? 'the other player';
  if (request.from === you) {
    playersRequestText.textContent = `Waiting for ${otherName} to accept ${WAIT_TEXT[request.kind]}…`;
    playersRequestActions.replaceChildren(button('Cancel', () => answer(false)));
    return;
  }
  const text = requestText(request, otherName);
  playersRequestText.textContent = text;
  playersRequestActions.replaceChildren(button('Accept', () => answer(true), true), button('Decline', () => answer(false)));
  if (prompted !== request.expiresAt && !seatPrompt.open) {
    prompted = request.expiresAt;
    seatPromptText.textContent = text;
    seatPrompt.showModal();
    seatPromptDecline.focus();
  }
}

export function renderPlayers(): void {
  const view = page.session;
  if (view === undefined || !shared()) {
    playersList.replaceChildren();
    playersRequest.hidden = true;
    if (seatPrompt.open) seatPrompt.close();
    return;
  }
  const you = view.you;
  const waiting = view.seatRequest !== null;
  // Watchers can only take an empty seat: X first, as join does.
  const free: Player | null = !view.seats.X ? 'X' : !view.seats.O ? 'O' : null;
  const seatRows = (['X', 'O'] as const).map((seat) => {
    const holder = seatHolder(view, seat);
    const actions: HTMLButtonElement[] = [];
    if (you === seat && !waiting) {
      actions.push(button('Swap X and O', () => act({ action: 'swap' }, 'X and O swapped.')));
      actions.push(button('Watch instead', () => act({ action: 'leave' }, 'You watch now. Your seat is free.')));
    } else if (you !== null && holder !== null && !waiting) {
      actions.push(button('Make watcher', () => act({ action: 'unseat' }, `${holder} watches now.`)));
    } else if (you === null && seat === free) {
      actions.push(button('Take the empty seat', () => void takeSeat()));
    }
    const note = holder === null ? 'Empty seat' : `${you === seat ? 'You · ' : ''}${view.presence[seat] ? 'here' : 'away'}`;
    return row(seat, holder ?? 'Nobody', note, actions);
  });
  const watcherRows = view.watchers.map((watcher) => {
    const name = watcher.player?.login ?? watcher.name;
    const actions: HTMLButtonElement[] = [];
    if (you !== null && !waiting) {
      if (!view.seats[other(you)]) actions.push(button('Seat here', () => act({ action: 'seat', watcher: watcher.id }, `${name} plays ${other(you)} now.`)));
      actions.push(button('Give my seat', () => act({ action: 'give', watcher: watcher.id }, `${name} plays ${you} now. You watch.`)));
      if (view.seats[other(you)]) actions.push(button('Replace', () => act({ action: 'replace', watcher: watcher.id }, `${name} plays ${other(you)} now.`)));
    }
    return row('watcher', name, watcher.id === view.youWatcher ? 'You · Watching' : 'Watching', actions);
  });
  playersList.replaceChildren(...seatRows, ...watcherRows);
  renderRequest(view);
}

// A watcher takes the empty seat, as a browser that opens the link does.
async function takeSeat(): Promise<void> {
  const session = page.session;
  if (session === undefined) return;
  sounds.click();
  await withBusy(async () => {
    applyView(await session.backend.join(session.code));
    if (page.session?.you) showToast(`You play ${page.session.you} now.`);
  });
}

// A message for a seat change that another screen made: the other player, or a request that ended.
// The view has no player ids, so a change of a name alone (a rename) gives no message.
// This screen's own actions show their own message after this one.
export function seatChangeText(before: SessionView, after: SessionView): string | undefined {
  const youText = after.you === null ? 'You watch now.' : `You play ${after.you} now.`;
  const request = before.seatRequest;
  if (request !== null && after.seatRequest === null && before.you !== null) {
    const otherName = seatHolder(before, other(before.you)) ?? 'The other player';
    const holders = (view: SessionView) => `${seatHolder(view, 'X')}|${seatHolder(view, 'O')}`;
    if (before.you !== after.you) return youText;
    if (holders(before) !== holders(after)) return `${otherName} accepted.`;
    if (after.now >= request.expiresAt) return 'The seat request ended without an answer.';
    return request.from === before.you ? `${otherName} declined.` : `${otherName} cancelled the request.`;
  }
  if (before.you !== after.you) return youText;
  for (const seat of ['X', 'O'] as const) {
    if (before.seats[seat] && !after.seats[seat]) return `Seat ${seat} is free now.`;
    if (!before.seats[seat] && after.seats[seat]) return `${seatHolder(after, seat)} plays ${seat} now.`;
  }
  return undefined;
}

export function setupPlayers(): void {
  seatPromptAccept.addEventListener('click', () => answer(true));
  seatPromptDecline.addEventListener('click', () => answer(false));
  // Escape only hides the prompt. The Players box still shows Accept and Decline until the request ends.
}
