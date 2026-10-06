// The Nearby panel: host or join a game on the local network over WebRTC.
// Online, hosted games also show in a list on the other devices of the network (server/lobby.ts).
import type { Player } from '../game.ts';
import { detectDevice, deviceLabel, DEVICE_ICONS } from '../nearby/device.ts';
import type { Announced, HostId, LobbyHost } from '../nearby/lobby.ts';
import { type Channel, createOffer, answerOffer } from '../nearby/peer.ts';
import { renderQr } from '../nearby/qr.ts';
import { type NearbyHost, type NearbyGuest, createNearbyHost, createNearbyGuest } from '../nearby/session.ts';
import { type Hello, HELLO_NAME_MAX_LENGTH, decodeSignal } from '../nearby/signal.ts';
import { nameOf } from '../names.ts';
import { OnlineError, api, token } from '../online.ts';
import type { Code, GameId, Metrics } from '../protocol.ts';
import { sounds } from '../sound.ts';
import {
  nearbyNameInput,
  nearbyStart,
  nearbyActions,
  nearbyAdd,
  nearbyStop,
  nearbyDeviceIcon,
  nearbyDevices,
  nearbyStep,
  nearbyStepText,
  nearbyQr,
  nearbyText,
  nearbyCodeOut,
  nearbyInput,
  nearbyCodeIn,
  nearbyHostButton,
  nearbyJoinButton,
  nearbyCancel,
  nearbyUseCode,
  nearbyCopy,
  nearbyLobby,
  nearbyHosts,
  nearbyHostsEmpty,
  nearbyOffline,
  nearbyVisible,
} from './dom.ts';
import { useHostLink } from './end-card.ts';
import { copyText, showProblem, showToast, showError } from './feedback.ts';
import { render } from './render.ts';
import { defaultSessionName, openSession, leaveSession } from './sessions.ts';
import { settings, saveSettings } from './settings.ts';
import { page } from './state.ts';

type NearbyState =
  | { kind: 'idle' }
  // Starting to host: the session is being made. Host and Join are hidden, so a second tap does nothing.
  | { kind: 'starting' }
  // Hosting: the open session is this device's, guests connect over WebRTC.
  | { kind: 'hosting'; host: NearbyHost; invite?: Invite }
  // Joining: waiting for the host's code, then showing our answer until the host connects.
  | JoiningState
  | { kind: 'guest'; guest: NearbyGuest; hostHello: Hello };
type JoiningState = { kind: 'joining'; answer?: { code: string; close(): void } };
type Invite = Awaited<ReturnType<typeof createOffer>>;

// Each Nearby step checks after every wait that its state is still the current one. A player who
// cancelled or left in the meantime then gets nothing back, and a late connection closes.

let nearby: NearbyState = { kind: 'idle' };
// The Nearby step for other modules. Only this module changes it.
export const nearbyKind = () => nearby.kind;
let wakeLock: { release(): Promise<void> } | undefined;
const thisDevice = detectDevice();

// The name that the other players see for this player, so the device list matches the score by default.
// Limit: 9 of the 67348 generated names are longer than HELLO_NAME_MAX_LENGTH, and the device list cuts
// them. Revisit this when the word lists grow, or when the limit changes in a new signal format.
const ownName = () => page.account.user?.login ?? nameOf(token);

function nearbyHello(): Hello {
  const name = nearbyNameInput.value.trim() || ownName();
  return { device: thisDevice, name: name.slice(0, HELLO_NAME_MAX_LENGTH) };
}

function deviceItem(hello: Hello | { device: 'server'; name: string }, role: string): HTMLLIElement {
  const item = document.createElement('li');
  const icon = document.createElement('span');
  icon.className = 'device-icon';
  icon.innerHTML = DEVICE_ICONS[hello.device];
  icon.title = deviceLabel(hello.device);
  const name = document.createElement('b');
  name.textContent = hello.name;
  const what = document.createElement('small');
  what.textContent = role;
  item.append(icon, name, what);
  return item;
}

function seatRole(seat: Player | null): string {
  return seat === null ? 'Watching' : `Plays ${seat}`;
}

async function renderNearby(): Promise<void> {
  const state = nearby;
  nearbyStart.hidden = state.kind !== 'idle';
  nearbyActions.hidden = state.kind !== 'hosting' && state.kind !== 'guest';
  nearbyAdd.hidden = state.kind !== 'hosting';
  nearbyStop.textContent = state.kind === 'guest' ? 'Leave' : 'End';
  nearbyDeviceIcon.innerHTML = DEVICE_ICONS[thisDevice];
  if (state.kind === 'hosting') {
    const hostSeat = page.session?.you ?? 'X';
    const guests = await state.host.guests();
    nearbyDevices.replaceChildren(
      deviceItem(nearbyHello(), `You · Host · Plays ${hostSeat}`),
      ...guests.map((guest) => deviceItem(guest.hello, seatRole(guest.seat))),
    );
  } else if (state.kind === 'guest') {
    nearbyDevices.replaceChildren(
      deviceItem(state.hostHello, 'Host'),
      deviceItem(nearbyHello(), `You · ${seatRole(page.session?.you ?? null)}`),
    );
  } else nearbyDevices.replaceChildren();
  nearbyDevices.hidden = nearbyDevices.childElementCount === 0;
  nearbyVisible.hidden = !(state.kind === 'hosting' && listed);
  nearbyOffline.hidden = !(state.kind === 'idle' && !navigator.onLine);
  renderLobby();
  void watchLobby();
}

// ---- Games near you ----

// The list of games near you shows while this device is online and idle in Nearby mode.
const lobbyWanted = () =>
  settings.mode === 'nearby' && nearby.kind === 'idle' && navigator.onLine && page.viewing === undefined && !document.hidden;
// The last list from the server. Undefined before the first answer, and after a failed request.
let lobbyHosts: LobbyHost[] | undefined;
// What the list shows, so a new answer with the same content keeps the buttons (and their focus).
let lobbyShown = '';
let lobbyWatching = false;
// Limit: the page asks for the list every LOBBY_POLL_MS, so a new host shows after that time at most.
// Revisit this with a long poll when idle Nearby pages make real load on the server.
const LOBBY_POLL_MS = 3000;
// A listed host answers within seconds while it is there. A guest gives up after this time.
const LISTED_JOIN_TIMEOUT_MS = 30_000;
// After a failed announcement, the host tries again after this time.
const ANNOUNCE_RETRY_MS = 5000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function watchLobby(): Promise<void> {
  if (lobbyWatching) return;
  lobbyWatching = true;
  try {
    while (lobbyWanted()) {
      lobbyHosts = await api.nearbyHosts().catch(() => undefined);
      renderLobby();
      await sleep(LOBBY_POLL_MS);
    }
  } finally {
    lobbyWatching = false;
  }
}

const hostedAgo = (age: number) => (age < 60 ? 'Hosts now' : `Hosts for ${Math.floor(age / 60)} min`);

function renderLobby(): void {
  nearbyLobby.hidden = !lobbyWanted() || lobbyHosts === undefined;
  const hosts = lobbyHosts ?? [];
  nearbyHostsEmpty.hidden = hosts.length > 0;
  const shown = JSON.stringify(hosts.map((host) => [host.id, host.name, host.device, hostedAgo(host.age)]));
  if (shown === lobbyShown) return;
  lobbyShown = shown;
  nearbyHosts.replaceChildren(
    ...hosts.map((host) => {
      const item = deviceItem(host, hostedAgo(host.age));
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'btn btn-small btn-primary';
      join.textContent = 'Join';
      join.setAttribute('aria-label', `Join ${host.name}`);
      join.addEventListener('click', () => {
        sounds.click();
        // The host makes a fresh offer after each guest, so take the newest one.
        const latest = lobbyHosts?.find((entry) => entry.id === host.id);
        if (latest === undefined) return showProblem(`${host.name} left the list.`);
        void joinListed(latest).catch((error: unknown) => nearbyProblem(error, 'Could not join.'));
      });
      item.append(join);
      return item;
    }),
  );
}

// ---- Announce the hosted game ----

// The announcement of the hosted game, while this device hosts and is online.
let announcing: AbortController | undefined;
// True while the server lists the hosted game.
let listed = false;

function announce(host: NearbyHost): void {
  if (announcing !== undefined || !navigator.onLine) return;
  const abort = new AbortController();
  announcing = abort;
  void announceLoop(host, abort.signal)
    .catch(showError)
    .finally(() => {
      if (announcing === abort) announcing = undefined;
      listed = false;
      void renderNearby();
    });
}

function stopAnnouncing(): void {
  announcing?.abort();
  announcing = undefined;
  listed = false;
}

// Holds one announce request open at a time (see server/lobby.ts). A request ends with the answer
// of a guest, or after about 25 s, and the next one starts at once.
async function announceLoop(host: NearbyHost, signal: AbortSignal): Promise<void> {
  const hosting = () => !signal.aborted && navigator.onLine && nearby.kind === 'hosting' && nearby.host === host;
  let offer = await createOffer(nearbyHello());
  let id: HostId | undefined;
  try {
    while (hosting()) {
      let reply: Announced;
      try {
        reply = await api.announceNearby(offer.code, id, signal);
      } catch (error) {
        if (!hosting()) return;
        // The server refuses the offer itself: a fault of this page, not of the network.
        if (error instanceof OnlineError && error.status === 400) throw error;
        // The entry expired, for example after a long pause of this page: announce a new game.
        if (error instanceof OnlineError && error.status === 404) {
          id = undefined;
          continue;
        }
        listed = false;
        void renderNearby();
        await sleep(ANNOUNCE_RETRY_MS);
        continue;
      }
      id = reply.id;
      if (!listed) {
        listed = true;
        void renderNearby();
      }
      if (reply.answer === null) continue;
      // An offer takes one answer, so the next guest needs a fresh offer.
      const used = offer;
      offer = await createOffer(nearbyHello());
      void acceptListedGuest(host, used, reply.answer);
    }
  } finally {
    offer.close();
  }
}

async function acceptListedGuest(host: NearbyHost, invite: Invite, answer: string): Promise<void> {
  try {
    const { channel, peer } = await invite.accept(answer);
    if (nearby.kind !== 'hosting' || nearby.host !== host) return channel.close();
    // Like a guest with codes: the open code step closes, and Add device opens a new one.
    cancelNearbyStep();
    welcomeGuest(host, channel, peer);
  } catch (error) {
    invite.close();
    nearbyProblem(error, 'A device could not join.');
  }
}

function welcomeGuest(host: NearbyHost, channel: Channel, peer: Hello): void {
  host.addGuest(channel, peer);
  sounds.sent();
  showToast(`${peer.name} joined.`);
  void renderNearby();
}

// A Nearby code as a link to this site. A phone's normal camera app opens it: an invite opens
// Nearby and joins, and an answer reaches the hosting tab in the same browser (see nearbyLinkCode).
const nearbyLink = (code: string) => `${location.origin}/?nearby=${encodeURIComponent(code)}`;

// Takes a bare code, or a link that carries one, and returns the bare code.
function nearbyCodeOf(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('http')) return trimmed;
  try {
    return new URL(trimmed).searchParams.get('nearby') ?? trimmed;
  } catch {
    return trimmed;
  }
}

function showNearbyStep(text: string, options: { code?: string; input?: boolean } = {}): void {
  nearbyStep.hidden = false;
  nearbyStepText.textContent = text;
  nearbyQr.hidden = options.code === undefined;
  nearbyText.hidden = options.code === undefined;
  nearbyCodeOut.value = options.code ?? '';
  nearbyInput.hidden = !options.input;
  nearbyCodeIn.value = '';
  if (options.code !== undefined) {
    const code = options.code;
    // The QR code holds a link, the text box the bare code. Both work in either place.
    void renderQr(nearbyLink(code)).then((svg) => {
      if (nearbyCodeOut.value === code) nearbyQr.replaceChildren(svg);
    });
  } else nearbyQr.replaceChildren();
}

function hideNearbyStep(): void {
  nearbyStep.hidden = true;
}

// Stops the shown step: a host keeps hosting, a joining device goes back to the start.
function cancelNearbyStep(): void {
  if (nearby.kind === 'hosting') nearby.invite?.close();
  if (nearby.kind === 'joining') nearby.answer?.close();
  hideNearbyStep();
  onNearbyCode = undefined;
  if (nearby.kind === 'joining') nearby = { kind: 'idle' };
  void renderNearby();
}

// Runs a code from the text box, or from a link that a camera opened, through the current step.
let onNearbyCode: ((code: string) => Promise<void>) | undefined;

function nearbyProblem(error: unknown, fallback: string): void {
  // Cancel, End and Leave stop an attempt on purpose, so they need no message.
  if (error instanceof DOMException && error.name === 'AbortError') return;
  showProblem(error instanceof Error ? error.message : fallback);
}

async function useNearbyCode(code: string): Promise<void> {
  const handler = onNearbyCode;
  if (handler === undefined) return;
  try {
    await handler(nearbyCodeOf(code));
  } catch (error) {
    nearbyProblem(error, 'That code did not work.');
  }
}

// The host shows an invite, scans or reads the guest's answer, and connects.
async function inviteGuest(): Promise<void> {
  if (nearby.kind !== 'hosting') return;
  const state = nearby;
  state.invite?.close();
  const invite = await createOffer(nearbyHello());
  // The host ended, or another invite started, while the code was made.
  if (nearby !== state) return invite.close();
  const current = { ...state, invite };
  nearby = current;
  showNearbyStep('1. Scan this code with the other device\'s camera. 2. Then scan the code that device shows with this device\'s camera, or paste it below.', {
    code: invite.code,
    input: true,
  });
  onNearbyCode = async (code) => {
    const { channel, peer } = await invite.accept(code);
    if (nearby !== current) return channel.close();
    onNearbyCode = undefined;
    hideNearbyStep();
    welcomeGuest(state.host, channel, peer);
  };
}

async function hostNearby(): Promise<void> {
  page.navigation++; // a slow load of another session must not replace this one
  const backend = page.local;
  if (backend === undefined) throw new Error('the device backend is not ready');
  const starting: NearbyState = { kind: 'starting' };
  nearby = starting;
  void renderNearby();
  const view = await backend.create({ mode: 'nearby', name: defaultSessionName('nearby'), clock: settings.clock, human: 'X' });
  if (nearby !== starting) return;
  openSession(view, backend, 'nearby');
  const host = createNearbyHost(backend, view.code, token);
  host.onGuestsChanged(() => void renderNearby());
  const hosting: NearbyState = { kind: 'hosting', host };
  nearby = hosting;
  // Keep the host's screen on: guests lose the game when the host's page sleeps.
  const lock = await navigator.wakeLock?.request('screen').catch(() => undefined);
  if (nearby !== hosting) return void lock?.release().catch(() => undefined);
  wakeLock = lock;
  announce(host);
  await inviteGuest();
  void renderNearby();
}

// Answers the host's offer, gives the answer code to `deliver`, and joins when the host connects.
async function connectGuest(joining: JoiningState, offerCode: string, deliver: (answer: { code: string; peer: Hello }) => Promise<void>): Promise<void> {
  const answer = await answerOffer(offerCode, nearbyHello());
  if (nearby !== joining) return answer.close();
  joining.answer = answer;
  try {
    await deliver(answer);
  } catch (error) {
    answer.close();
    throw error;
  }
  const channel = await answer.connected;
  if (nearby !== joining) return channel.close();
  const guest = createNearbyGuest(channel, token, (reason) => {
    if (nearby.kind !== 'guest' || nearby.guest !== guest) return;
    showToast(reason);
    endNearby(false);
  });
  guest.onLink((game, id) => {
    if (nearby.kind !== 'guest' || nearby.guest !== guest || page.session?.mode !== 'nearby') return;
    useHostLink(page.session, game, id);
  });
  nearby = { kind: 'guest', guest, hostHello: answer.peer };
  hideNearbyStep();
  let view = await guest.load('' as Code);
  if (view.you === null && (!view.seats.X || !view.seats.O)) view = await guest.join(view.code);
  // The player left while the game loaded. endNearby closed the connection already.
  if (nearby.kind !== 'guest' || nearby.guest !== guest) return;
  openSession(view, guest, 'nearby');
  sounds.sent();
  showToast(view.you === null ? 'Both seats are taken. You are watching.' : `Joined the game hosted on ${answer.peer.name} as ${view.you}.`);
  void renderNearby();
}

function startJoining(): JoiningState {
  page.navigation++; // a slow load of another session must not replace the joined one
  const joining: JoiningState = { kind: 'joining' };
  nearby = joining;
  void renderNearby();
  return joining;
}

// Joins with codes: the guest reads the host's code, and shows its answer code to the host.
async function joinNearby(code?: string): Promise<void> {
  const joining = startJoining();
  showNearbyStep("Scan the host's code with this device's camera, or paste it below.", { input: true });
  onNearbyCode = (offerCode) =>
    connectGuest(joining, offerCode, async (answer) => {
      showNearbyStep(`Show this code to ${answer.peer.name}, the host, to scan.`, { code: answer.code });
      onNearbyCode = undefined;
    });
  if (code !== undefined) await useNearbyCode(code);
}

// Joins a game from the list: the answer code goes to the host through the server.
async function joinListed(host: LobbyHost): Promise<void> {
  const joining = startJoining();
  showNearbyStep(`Connecting to ${host.name}…`);
  const timer = setTimeout(() => {
    if (nearby !== joining || joining.answer === undefined) return;
    showProblem(`${host.name} did not answer. Try again.`);
    cancelNearbyStep();
  }, LISTED_JOIN_TIMEOUT_MS);
  try {
    await connectGuest(joining, host.offer, async (answer) => {
      await api.answerNearby(host.id, host.offer, answer.code);
    });
  } catch (error) {
    if (nearby === joining) cancelNearbyStep();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Answer codes scanned with a normal camera open a new tab. That tab hands the code to the
// hosting tab of the same browser over this channel, so the host never copies anything.
const nearbyHandoff = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('tick3d-nearby');

// Handles a page opened from a Nearby QR code: an invite joins, an answer goes to the hosting tab.
export async function openNearbyLink(code: string): Promise<void> {
  const url = new URL(location.href);
  url.searchParams.delete('nearby');
  history.replaceState(null, '', url);
  settings.mode = 'nearby';
  saveSettings();
  openNearby();
  if ((await decodeSignal(code).catch(() => undefined))?.kind === 'answer') {
    nearbyHandoff?.postMessage(code);
    showNearbyStep('The code went to the tab that hosts the game. You can close this tab.');
    return;
  }
  await joinNearby(code);
}

// Leaves Nearby play. The host says goodbye to its guests; a guest closes its connection.
export function endNearby(sayBye = true): void {
  stopAnnouncing();
  const state = nearby;
  if (state.kind === 'hosting') state.invite?.close();
  if (state.kind === 'joining') state.answer?.close();
  if (state.kind === 'hosting') state.host.stop('The host ended the game.');
  if (state.kind === 'guest' && sayBye) state.guest.close();
  void wakeLock?.release().catch(() => undefined);
  wakeLock = undefined;
  onNearbyCode = undefined;
  hideNearbyStep();
  nearby = { kind: 'idle' };
  if (page.session?.mode === 'nearby') leaveSession();
  render();
  void renderNearby();
}

// Opens the Nearby panel. A session starts when this device hosts or joins.
export function openNearby(): void {
  if (nearbyNameInput.value === '') nearbyNameInput.value = ownName();
  render();
  void renderNearby();
}

export function setupNearby(): void {
  nearbyHandoff?.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (nearby.kind === 'hosting' && onNearbyCode !== undefined && typeof event.data === 'string') {
      void useNearbyCode(event.data);
    }
  });

  nearbyHostButton.addEventListener('click', () => {
    sounds.click();
    void hostNearby().catch((error: unknown) => {
      showProblem(error instanceof Error ? error.message : 'Could not start hosting.');
      endNearby();
    });
  });
  nearbyJoinButton.addEventListener('click', () => {
    sounds.click();
    void joinNearby().catch((error: unknown) => showProblem(error instanceof Error ? error.message : 'Could not join.'));
  });
  nearbyAdd.addEventListener('click', () => void inviteGuest().catch(showError));
  nearbyStop.addEventListener('click', () => endNearby());
  nearbyCancel.addEventListener('click', cancelNearbyStep);
  // Online, a host announces its game and an idle device reads the list. Offline, only codes work.
  addEventListener('online', () => {
    if (nearby.kind === 'hosting') announce(nearby.host);
    void renderNearby();
  });
  addEventListener('offline', () => {
    stopAnnouncing();
    void renderNearby();
  });
  document.addEventListener('visibilitychange', () => void renderNearby());
  nearbyUseCode.addEventListener('click', () => void useNearbyCode(nearbyCodeIn.value));
  nearbyCopy.addEventListener('click', () => {
    void copyText(nearbyCodeOut.value).then(
      () => showToast('Code copied.'),
      () => showProblem('Copy did not work. Select the code and copy it.'),
    );
  });
}

// The host gives the link of a finished game to its guests (see useHostLink in end-card.ts).
export function shareGameLink(game: number, id: GameId): void {
  if (nearby.kind === 'hosting') nearby.host.shareLink(game, id);
}

// This device's part in the live Nearby game and the kind of the other player's device, for the game metrics.
export async function nearbyMetrics(): Promise<Metrics['nearby']> {
  const state = nearby;
  if (state.kind === 'guest') return { role: 'guest', other: state.hostHello.device };
  if (state.kind !== 'hosting') return null;
  const player = (await state.host.guests()).find((guest) => guest.seat !== null);
  return { role: 'host', other: player?.hello.device ?? null };
}
