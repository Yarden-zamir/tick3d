// The testing page (/testing): the steps to join the closed test on Android or iPhone, and the Google Play
// promo codes of the Android path (src/testing/codes.ts). The page keeps the codes that it claimed in localStorage.
import '../style.css';
import './testing.css';
import { element } from '../element.ts';
import { setupPageHeader } from '../header/header.ts';
import { renderQr } from '../nearby/qr.ts';
import { OnlineError, api } from '../online.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import { type MyCode, TESTER_NAME_MAX_LENGTH, type TesterCode, parseClaimRequest, parseMyCodes, redeemUrl } from './codes.ts';
import { PHONES, type Phone, isPhone, phoneOf } from './phone.ts';

setupPageHeader();

const paths: Record<Phone, HTMLElement> = { android: element('#android-path', HTMLElement), iphone: element('#iphone-path', HTMLElement) };
const choices: Record<Phone, HTMLButtonElement> = { android: element('#pick-android', HTMLButtonElement), iphone: element('#pick-iphone', HTMLButtonElement) };
const inviteLink = element('#testflight-link', HTMLAnchorElement);
const inviteQr = element('#invite-qr', HTMLElement);
const myCodesBox = element('#my-codes', HTMLDivElement);
const note = element('#codes-note', HTMLParagraphElement);
const grid = element('#code-grid', HTMLDivElement);
const empty = element('#codes-empty', HTMLDivElement);
const dialog = element('#claim-dialog', HTMLDialogElement);
const form = element('#claim-form', HTMLFormElement);
const warning = element('#claim-warning', HTMLParagraphElement);
const emailInput = element('#claim-email', HTMLInputElement);
const nameInput = element('#claim-name', HTMLInputElement);
const claimError = element('#claim-error', HTMLParagraphElement);
const submit = element('#claim-submit', HTMLButtonElement);

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---- Storage ----

function readStored(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

// False when storage is blocked or full.
function writeStored(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const mine: MyCode[] = parseMyCodes(readStored(STORAGE_KEYS.testerCodes));

// ---- The phone ----

let qrShown = false;

function showPhone(phone: Phone | null): void {
  for (const each of PHONES) {
    choices[each].setAttribute('aria-pressed', String(each === phone));
    // A path that turns visible plays its entrance animation again (testing.css).
    paths[each].hidden = each !== phone;
  }
  if (phone === 'android' && !codesLoaded) void loadCodes();
  if (phone === 'iphone' && !qrShown) {
    qrShown = true;
    void renderQr(inviteLink.href).then((svg) => inviteQr.append(svg));
  }
}

for (const phone of PHONES) {
  choices[phone].addEventListener('click', () => {
    writeStored(STORAGE_KEYS.testerPhone, phone);
    showPhone(phone);
    paths[phone].scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
  });
}

// ---- Avatars ----

// The colours of the letter avatars: the accent colours of the theme, so each theme keeps its look.
const AVATAR_COLORS = ['--x', '--o', '--win', '--primary', '--toggle-on', '--danger'] as const;

function colorOf(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return `var(${AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? '--primary'})`;
}

// The first letter of the name, with the Gravatar picture over it. Without a picture, Gravatar answers 404
// (d=404), and the letter shows.
function avatar(name: string, gravatar: string | null): HTMLSpanElement {
  const box = document.createElement('span');
  box.className = 'tester-avatar';
  box.style.background = colorOf(name);
  box.textContent = [...name][0]?.toUpperCase() ?? '?';
  box.setAttribute('aria-hidden', 'true');
  if (gravatar !== null) {
    // The picture goes in only after it loads, so a missing picture never covers the letter.
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', () => box.append(img));
    img.src = `https://gravatar.com/avatar/${gravatar}?s=96&d=404`;
  }
  return box;
}

function person(name: string, gravatar: string | null): HTMLSpanElement {
  const box = document.createElement('span');
  box.className = 'tester';
  const label = document.createElement('span');
  label.className = 'tester-name';
  label.textContent = name;
  box.append(avatar(name, gravatar), label);
  return box;
}

// ---- The codes ----

let codes: TesterCode[] = [];
let codesLoaded = false;
const cards = new Map<number, HTMLButtonElement>();

const isMine = (id: number) => mine.some((code) => code.id === id);
const gravatarOf = (id: number) => codes.find((code) => code.id === id)?.gravatar ?? null;

function copyButton(code: string, target: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.textContent = 'Copy';
  button.addEventListener('click', () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        button.textContent = 'Copied!';
        setTimeout(() => (button.textContent = 'Copy'), 1500);
      })
      .catch(() => {
        // No clipboard access (plain HTTP, or a refusal): select the code, so a long press copies it.
        getSelection()?.selectAllChildren(target);
      });
  });
  return button;
}

// The codes and pictures that the panel shows now. A refresh with no change keeps the panel, so it does not pop again.
let mineShown = '';

function renderMine(): void {
  const shown = JSON.stringify(mine.map(({ id, code, name }) => [id, code, name, gravatarOf(id)]));
  if (shown === mineShown) return;
  mineShown = shown;
  myCodesBox.replaceChildren(
    ...mine.map(({ id, code, name }) => {
      const box = document.createElement('div');
      box.className = 'my-code';
      const head = document.createElement('div');
      head.className = 'my-code-head';
      const title = document.createElement('b');
      title.textContent = 'Your code';
      head.append(title, person(name, gravatarOf(id)));
      const text = document.createElement('code');
      text.className = 'my-code-text';
      text.textContent = code;
      const actions = document.createElement('div');
      actions.className = 'my-code-actions';
      const redeem = document.createElement('a');
      redeem.className = 'btn btn-primary';
      redeem.href = redeemUrl(code);
      redeem.target = '_blank';
      redeem.rel = 'noopener';
      redeem.textContent = 'Redeem in Play';
      actions.append(copyButton(code, text), redeem);
      box.append(head, text, actions);
      return box;
    }),
  );
}

// The slot number on both faces of a card.
function slotNumber(slot: number): HTMLSpanElement {
  const number = document.createElement('span');
  number.className = 'code-slot';
  number.textContent = `#${slot}`;
  return number;
}

// A card has a front (the hint and "Tap to claim") and a back (who has it). A claimed card turns to its back.
// The server sends the codes in a fixed order (their id), so slot `index + 1` is the same card for every visitor.
function newCard(code: TesterCode, index: number): HTMLButtonElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'code-card';
  card.style.setProperty('--i', String(index));
  card.dataset.slot = String(index + 1);
  const front = document.createElement('span');
  front.className = 'code-face code-front';
  const hint = document.createElement('span');
  hint.className = 'code-hint';
  hint.textContent = code.hint;
  const dots = document.createElement('span');
  dots.className = 'code-dots';
  dots.textContent = '••••••••';
  const tap = document.createElement('span');
  tap.className = 'code-tap';
  tap.textContent = 'Tap to claim';
  front.append(slotNumber(index + 1), hint, dots, tap);
  const back = document.createElement('span');
  back.className = 'code-face code-back';
  card.append(front, back);
  card.addEventListener('click', () => openClaim(code.id));
  return card;
}

function updateCard(card: HTMLButtonElement, code: TesterCode): void {
  const state = isMine(code.id) ? 'mine' : code.claimed ? 'taken' : 'free';
  // A refresh changes only the cards that changed, so the grid and the scroll stay.
  if (card.dataset.state === state) return;
  card.dataset.state = state;
  card.disabled = state !== 'free';
  const slot = `#${card.dataset.slot ?? ''}`;
  card.setAttribute('aria-label', state === 'free' ? `Claim code ${slot}, it starts with ${code.hint}` : `Code ${slot}: ${state === 'mine' ? 'yours' : `taken by ${code.name ?? 'a tester'}`}`);
  const back = card.querySelector('.code-back');
  if (!(back instanceof HTMLSpanElement)) throw new Error('a code card has no back');
  const myName = mine.find((entry) => entry.id === code.id)?.name;
  const name = code.name ?? myName ?? null;
  const stamp = document.createElement('span');
  stamp.className = 'code-stamp';
  stamp.textContent = state === 'mine' ? 'yours' : 'taken';
  back.replaceChildren(slotNumber(Number(card.dataset.slot)), stamp, ...(name === null ? [] : [person(name, code.gravatar)]));
}

// A message after the count, such as "Somebody else took this code". The next claim clears it.
let notice = '';

function render(): void {
  renderMine();
  codes.forEach((code, index) => {
    let card = cards.get(code.id);
    if (card === undefined) {
      // A new code from a new secret value comes after the others, so it takes the next slot.
      card = newCard(code, index);
      cards.set(code.id, card);
      grid.append(card);
    }
    updateCard(card, code);
  });
  const free = codes.filter((code) => !code.claimed).length;
  empty.hidden = !codesLoaded || free > 0;
  note.hidden = codesLoaded && codes.length === 0;
  if (codesLoaded) note.textContent = [`${free} of ${codes.length} codes left.`, notice].filter(Boolean).join(' ');
}

async function loadCodes(): Promise<void> {
  try {
    codes = (await api.testerCodes()).codes;
    codesLoaded = true;
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    // A failed refresh keeps the cards that the page shows.
    if (!codesLoaded) note.textContent = `${error.message} Reload the page to try again.`;
    return;
  }
  render();
}

// Other testers claim codes too, so the list refreshes while the Android path shows, and when the page comes back.
const REFRESH_MS = 20_000;
function refresh(): void {
  if (codesLoaded && !paths.android.hidden && document.visibilityState === 'visible') void loadCodes();
}
setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', refresh);
addEventListener('focus', refresh);

// ---- Claim ----

let claiming: number | undefined;

function openClaim(id: number): void {
  claiming = id;
  warning.hidden = mine.length === 0;
  claimError.hidden = true;
  const last = mine.at(-1);
  if (last !== undefined && emailInput.value === '') {
    emailInput.value = last.email;
    nameInput.value = last.name;
  }
  dialog.showModal();
}

function showClaimError(message: string): void {
  claimError.textContent = message;
  claimError.hidden = false;
}

// A short burst of confetti from the card. It needs motion, so reduced motion skips it.
// The burst sits on the page, not in the card: the card turns in 3D, and its faces would cover the pieces.
function burst(card: HTMLElement): void {
  if (reducedMotion.matches) return;
  const box = document.createElement('span');
  box.className = 'claim-burst';
  box.setAttribute('aria-hidden', 'true');
  const { left, top, width, height } = card.getBoundingClientRect();
  box.style.left = `${left + scrollX + width / 2}px`;
  box.style.top = `${top + scrollY + height / 2}px`;
  for (let i = 0; i < 16; i++) {
    const piece = document.createElement('span');
    piece.style.setProperty('--angle', `${(360 / 16) * i + Math.random() * 12}deg`);
    piece.style.setProperty('--distance', `${70 + Math.random() * 60}px`);
    piece.style.setProperty('--color', colorOf(String(i)));
    box.append(piece);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 1000);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const id = claiming;
  if (id === undefined) throw new Error('the claim form is open without a code');
  const claim = parseClaimRequest({ email: emailInput.value, name: nameInput.value });
  if (claim === undefined) {
    showClaimError(`Type a valid email and a name of 1 to ${TESTER_NAME_MAX_LENGTH} letters.`);
    return;
  }
  submit.disabled = true;
  api
    .claimTesterCode(id, claim)
    .then(({ code }) => {
      mine.push({ id, code, ...claim });
      const kept = writeStored(STORAGE_KEYS.testerCodes, mine);
      dialog.close();
      notice = kept ? '' : 'This browser cannot keep your code, so copy it now.';
      render();
      const card = cards.get(id);
      if (card !== undefined) burst(card);
      return loadCodes();
    })
    .catch((error: unknown) => {
      if (!(error instanceof OnlineError)) throw error;
      if (error.status === 409 || error.status === 404) {
        dialog.close();
        notice = error.message;
        void loadCodes();
        return;
      }
      showClaimError(error.message);
    })
    .finally(() => {
      submit.disabled = false;
    });
});

element('#claim-cancel', HTMLButtonElement).addEventListener('click', () => dialog.close());
element('#claim-close', HTMLButtonElement).addEventListener('click', () => dialog.close());

// ---- Start ----

const stored = readStored(STORAGE_KEYS.testerPhone);
renderMine();
showPhone(isPhone(stored) ? stored : phoneOf(navigator.userAgent));
