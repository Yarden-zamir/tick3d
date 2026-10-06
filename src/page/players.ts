// The Players box of a game with another device: the seats, the watchers, and the seat controls.
// The session rules (seat and answerSeat in src/session/core.ts) decide; this module only asks.
// A change of the other player's seat waits for that player: they get a prompt to accept or decline.
import { type Player, other } from '../game.ts';
import type { ConsentAction, SeatAction, SeatRequestView, SessionView } from '../protocol.ts';
import { EYE_ICON } from '../icons.ts';
import { sounds } from '../sound.ts';
import {
  playersBox,
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

// The watcher that a replace request seats.
const requestWatcher = (request: SeatRequestView): string => request.watcher?.player?.login ?? request.watcher?.name ?? 'a watcher';

function requestText(request: SeatRequestView, asker: string): string {
  const texts: Record<ConsentAction, string> = {
    swap: `${asker} wants to swap X and O.`,
    unseat: `${asker} wants you to watch instead. Your seat is then free.`,
    replace: `${asker} wants ${requestWatcher(request)} to take your seat. You then watch.`,
    undo: `${asker} wants to take back their last move.`,
  };
  return texts[request.kind];
}

// What a request asks for, as a noun: "Waiting for Bob to accept the swap", "Bob declined the swap".
function requestNoun(request: SeatRequestView): string {
  const texts: Record<ConsentAction, string> = {
    swap: 'the swap',
    unseat: 'the move to watching',
    replace: `${requestWatcher(request)} in their seat`,
    undo: 'the undo',
  };
  return texts[request.kind];
}

// A button of the Players box. `key` names the button across renders, so keyboard focus stays on it
// when the box draws again (every view update draws it). `tip` says what the button changes.
type SeatButton = { key: string; label: string; tip?: string; run: () => void; primary?: boolean; disabled?: boolean };

function button({ key, label, tip, run, primary = false, disabled = false }: SeatButton): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.className = primary ? 'btn btn-small btn-primary' : 'btn btn-small';
  element.dataset.key = key;
  if (tip !== undefined) element.dataset.tip = tip;
  element.disabled = page.busy || disabled;
  element.addEventListener('click', run);
  return element;
}

// The key of the Players box button that has the keyboard focus, or undefined. A button loses the
// focus while it is disabled (a busy request), so the key stays until the focus goes elsewhere.
let focusKey: string | undefined;

function restoreFocus(): void {
  if (focusKey === undefined) return;
  const active = document.activeElement;
  if (active !== null && active !== document.body && !playersBox.contains(active)) return;
  const target = playersBox.querySelector<HTMLButtonElement>(`button[data-key="${focusKey}"]`);
  if (target !== null && !target.disabled && target !== active) target.focus();
}

// Undo in a game with another device: a request to take back the own last move.
export function requestUndo(): void {
  act({ action: 'undo' }, 'Your last move is back.');
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
    const you = page.session?.you ?? null;
    if (accept && you !== session.you) showToast(you === null ? 'You watch now.' : `You play ${you} now.`);
    else showToast(accept ? 'Accepted.' : session.seatRequest?.from === session.you ? 'Request cancelled.' : 'Declined.');
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
  // Each screen drops a request that ended without an answer by itself: the holder sends no event for it.
  expiryTimer = setTimeout(() => void refresh(code), Math.max(0, request.expiresAt - nowMs()) + 500);
  playersRequest.hidden = false;
  const otherSeat = other(you);
  const otherName = seatHolder(view, otherSeat) ?? 'the other player';
  if (request.from === you) {
    const away = view.presence[otherSeat] ? '' : ` ${otherName} is away.`;
    playersRequestText.textContent = `Waiting for ${otherName} to accept ${requestNoun(request)}.${away} The request ends after 1 minute.`;
    playersRequestActions.replaceChildren(button({ key: 'cancel', label: 'Cancel', run: () => answer(false) }));
    return;
  }
  const text = requestText(request, otherName);
  playersRequestText.textContent = text;
  playersRequestActions.replaceChildren(
    button({ key: 'accept', label: 'Accept', run: () => answer(true), primary: true }),
    button({ key: 'decline', label: 'Decline', run: () => answer(false) }),
  );
  // A new request can replace the open one while the prompt shows. The prompt then shows the new text.
  if (seatPrompt.open) seatPromptText.textContent = text;
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
  // While a request waits, the seat controls stay in place but are off, so the box does not jump.
  // The request box under the list says why.
  const waiting = view.seatRequest !== null;
  // Watchers can only take an empty seat: X first, as join does.
  const free: Player | null = !view.seats.X ? 'X' : !view.seats.O ? 'O' : null;
  const seatRows = (['X', 'O'] as const).map((seat) => {
    const holder = seatHolder(view, seat);
    const actions: HTMLButtonElement[] = [];
    if (you === seat) {
      const swapTip = holder === null || !view.seats[other(seat)] ? 'X and O trade seats.' : 'X and O trade seats. The other player must accept.';
      actions.push(button({ key: 'you:swap', label: 'Swap X and O', tip: swapTip, disabled: waiting, run: () => act({ action: 'swap' }, 'X and O swapped.') }));
      actions.push(
        button({ key: 'you:leave', label: 'Watch instead', tip: 'You watch, and your seat is free.', disabled: waiting, run: () => act({ action: 'leave' }, 'You watch now. Your seat is free.') }),
      );
    } else if (you !== null && holder !== null) {
      actions.push(
        button({
          key: 'other:unseat',
          label: 'Move to watchers',
          tip: `${holder} watches, and the seat is free. ${holder} must accept.`,
          disabled: waiting,
          run: () => act({ action: 'unseat' }, `${holder} watches now.`),
        }),
      );
    } else if (you === null && seat === free) {
      actions.push(button({ key: `take:${seat}`, label: `Play ${seat}`, tip: `You take the empty ${seat} seat.`, run: () => void takeSeat() }));
    }
    const note = holder === null ? 'Waiting for a player' : `${you === seat ? 'You · ' : ''}${view.presence[seat] ? 'here' : 'away'}`;
    return row(seat, holder ?? 'Empty seat', note, actions);
  });
  const watcherRows = view.watchers.map((watcher) => {
    const name = watcher.player?.login ?? watcher.name;
    const actions: HTMLButtonElement[] = [];
    if (you !== null) {
      const otherSeat = other(you);
      const otherHolder = seatHolder(view, otherSeat);
      actions.push(
        button({
          key: `${watcher.id}:give`,
          label: 'Give my seat',
          tip: `${name} plays ${you}, and you watch.`,
          disabled: waiting,
          run: () => act({ action: 'give', watcher: watcher.id }, `${name} plays ${you} now. You watch.`),
        }),
      );
      // An empty seat takes the watcher at once. A taken seat asks its player first (replace).
      const action = otherHolder === null ? 'seat' : 'replace';
      actions.push(
        button({
          key: `${watcher.id}:${action}`,
          label: `Seat as ${otherSeat}`,
          tip: otherHolder === null ? `${name} plays ${otherSeat}.` : `${name} plays ${otherSeat}, and ${otherHolder} watches. ${otherHolder} must accept.`,
          disabled: waiting,
          run: () => act({ action, watcher: watcher.id }, `${name} plays ${otherSeat} now.`),
        }),
      );
    }
    return row('watcher', name, watcher.id === view.youWatcher ? 'You · Watching' : 'Watching', actions);
  });
  playersList.replaceChildren(...seatRows, ...watcherRows);
  renderRequest(view);
  restoreFocus();
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
    const movesOf = (view: SessionView) => view.games.at(-1)?.moves.length ?? 0;
    if (holders(before) !== holders(after) || (request.kind === 'undo' && movesOf(after) < movesOf(before))) return `${otherName} accepted ${requestNoun(request)}.`;
    const noun = requestNoun(request);
    // A move ends an undo request: the move to take back is not the last one any more.
    if (request.kind === 'undo' && movesOf(after) > movesOf(before)) {
      return request.from === before.you ? `${otherName} moved, so the undo request ended.` : 'Your move ended the undo request.';
    }
    if (after.now >= request.expiresAt) return `The request for ${noun} ended without an answer.`;
    return request.from === before.you ? `${otherName} declined ${noun}.` : `${otherName} cancelled the request.`;
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
  playersBox.addEventListener('focusin', (event) => {
    focusKey = event.target instanceof HTMLElement ? event.target.dataset.key : undefined;
  });
  document.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Node) || !playersBox.contains(event.target)) focusKey = undefined;
  });
  // A focus that moves out of the box ends the restore. A disabled button drops the focus to nothing (relatedTarget null).
  playersBox.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && !playersBox.contains(event.relatedTarget)) focusKey = undefined;
  });
  // Escape only hides the prompt. The Players box still shows Accept and Decline until the request ends.
}
