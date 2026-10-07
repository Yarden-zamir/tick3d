// The kitshn button and the Previews dialog: the production site and the open pull requests with a live preview.
// A stacked pull request shows in a nested list inside the card of its parent.
import { api, OnlineError } from '../online.ts';
import { element } from '../element.ts';
import { type PreviewNode, previewTree } from './preview-tree.ts';

const previewsButton = element('#previews-button', HTMLButtonElement);
export const previewsDialog = element('#previews', HTMLDialogElement);
const previewsClose = element('#previews-close', HTMLButtonElement);
const previewsNote = element('#previews-note', HTMLParagraphElement);
const previewsList = element('#previews-list', HTMLUListElement);

// The pull request number of this page, when the page itself is a preview (pr.<n>.<domain>).
function previewNumberOf(hostname: string): number | undefined {
  const [prefix, number] = hostname.split('.');
  if (prefix !== 'pr' || number === undefined || number === '') return undefined;
  const value = Number(number);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

// "3 hours ago", or "now" under a minute.
function timeAgo(time: number, now: number): string {
  const elapsed = Math.max(0, now - time);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of UNITS) if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  return 'now';
}

function link(text: string, href: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  anchor.textContent = text;
  return anchor;
}

function badge(text: string, className = 'badge'): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.className = className;
  mark.textContent = text;
  return mark;
}

// One card, with the cards of its stacked pull requests nested inside. `here` is the number of this page's preview.
function previewItem({ preview, children }: PreviewNode, here: number | undefined): HTMLLIElement {
  const item = document.createElement('li');
  item.className = preview.number === here ? 'preview here' : 'preview';
  const head = document.createElement('div');
  head.className = 'preview-head';
  const title = document.createElement('b');
  title.textContent = `${preview.title} #${preview.number}`;
  head.append(title);
  if (preview.parent !== null) head.append(badge(`Depends on #${preview.parent}`, 'badge badge-quiet'));
  if (preview.draft) head.append(badge('Draft'));
  if (preview.number === here) head.append(badge('You are here'));
  item.append(head);
  if (preview.description !== '') {
    const description = document.createElement('p');
    description.textContent = preview.description;
    item.append(description);
  }
  const people = document.createElement('div');
  people.className = 'preview-people';
  for (const person of preview.contributors) {
    const anchor = link('', person.url);
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = `${person.avatar}&s=40`;
    avatar.alt = '';
    avatar.loading = 'lazy';
    anchor.append(avatar, person.login);
    people.append(anchor);
  }
  const foot = document.createElement('div');
  foot.className = 'preview-foot';
  const updated = document.createElement('small');
  updated.textContent = `Updated ${timeAgo(preview.updatedAt, Date.now())}`;
  foot.append(updated, link('Open preview', preview.previewUrl), link('Pull request', preview.url));
  item.append(people, foot);
  if (children.length > 0) {
    const stacked = document.createElement('ul');
    stacked.className = 'preview-children';
    stacked.setAttribute('aria-label', `Stacked on #${preview.number}`);
    stacked.append(...children.map((child) => previewItem(child, here)));
    item.append(stacked);
  }
  return item;
}

// The production site, built from the main branch.
function mainItem(url: string): HTMLLIElement {
  const here = location.origin === url;
  const item = document.createElement('li');
  item.className = here ? 'preview here' : 'preview';
  const head = document.createElement('div');
  head.className = 'preview-head';
  const title = document.createElement('b');
  title.textContent = 'Main';
  head.append(title);
  if (here) head.append(badge('You are here'));
  const description = document.createElement('p');
  description.textContent = 'The production site, built from the main branch.';
  const foot = document.createElement('div');
  foot.className = 'preview-foot';
  foot.append(link('Open site', url));
  item.append(head, description, foot);
  return item;
}

function showMessage(text: string): void {
  const item = document.createElement('li');
  item.className = 'empty';
  item.textContent = text;
  previewsList.replaceChildren(item);
}

// Opening the dialog again while the list loads starts over, so a late answer never shows.
let request = 0;

async function openPreviews(): Promise<void> {
  const mine = ++request;
  previewsDialog.showModal();
  previewsNote.textContent = 'The production site and the open pull requests with a live preview.';
  previewsNote.classList.remove('error');
  showMessage('Loading…');
  if (!navigator.onLine) return showMessage('You are offline. The list needs a network.');
  try {
    const { main, previews, error } = await api.previews();
    if (mine !== request) return;
    if (error !== null) {
      previewsNote.textContent = error;
      previewsNote.classList.add('error');
    }
    const here = previewNumberOf(location.hostname);
    const items = previewTree(previews).map((node) => previewItem(node, here));
    if (main !== null) items.unshift(mainItem(main));
    previewsList.replaceChildren(...items);
    if (items.length === 0) showMessage('No open previews.');
  } catch (error) {
    // The list itself says what went wrong: the dialog covers the toasts, and only the game page has them.
    if (mine === request) showMessage(error instanceof OnlineError ? `The list did not load. ${error.message}` : 'The list did not load.');
    if (!(error instanceof OnlineError)) throw error;
  }
}

export function setupPreviews(): void {
  // openPreviews shows a failed call in the list. Any other error is a bug and stays uncaught.
  previewsButton.addEventListener('click', () => void openPreviews());
  previewsClose.addEventListener('click', () => previewsDialog.close());
  previewsDialog.addEventListener('click', (event) => {
    if (event.target === previewsDialog) previewsDialog.close();
  });
}
