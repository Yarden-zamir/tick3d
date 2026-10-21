// Preview of the 3 redesigns of My games (issue #210): ?mygames=a, b or c on the page address.
// It moves the sections of the dialog, so the lists and buttons work as before.
// Limit: a preview for the pick only. Replace it with the picked design before this branch merges.
import {
  accountBox,
  myGamesAchievements,
  myGamesAchievementsSummary,
  myGamesBlockedBox,
  myGamesDevice,
  myGamesDialog,
  myGamesHistory,
  myGamesNote,
  myGamesOnlineBox,
  myGamesPrivateOption,
  myGamesSessionBox,
  myGamesStats,
} from './dom.ts';

const LAYOUTS = ['a', 'b', 'c'] as const;
type Layout = (typeof LAYOUTS)[number];

const sectionOf = (child: Element): HTMLElement => {
  const section = child.closest('section');
  if (section === null) throw new Error('a My games list is outside its section');
  return section;
};

function part(className: string, children: readonly Element[]): HTMLDivElement {
  const box = document.createElement('div');
  box.className = className;
  box.append(...children);
  return box;
}

function button(label: string, run: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'btn btn-small';
  element.textContent = label;
  element.addEventListener('click', run);
  return element;
}

function fold(title: string, children: readonly Element[]): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'my-games-fold my-games-card';
  const summary = document.createElement('summary');
  const heading = document.createElement('h3');
  heading.textContent = title;
  summary.append(heading);
  details.append(summary, ...children);
  return details;
}

// A: tabs for Games, Achievements and Account.
function tabs(head: Element, games: Element[], achievements: Element[], account: Element[]): void {
  const panels = [part('my-games-panel', games), part('my-games-panel', achievements), part('my-games-panel', account)];
  const bar = document.createElement('div');
  bar.className = 'my-games-tabs';
  bar.setAttribute('role', 'tablist');
  const buttons = ['Games', 'Achievements', 'Account'].map((label, index) => {
    const tab = button(label, () => show(index));
    tab.setAttribute('role', 'tab');
    return tab;
  });
  const show = (index: number) => {
    for (const [other, panel] of panels.entries()) panel.hidden = other !== index;
    for (const [other, tab] of buttons.entries()) tab.setAttribute('aria-selected', String(other === index));
  };
  bar.append(...buttons);
  head.after(bar, ...panels);
  show(0);
}

// B: one scroll. The play lists first, a row of jump buttons, the long parts folded.
function oneScroll(head: Element, games: Element[], achievements: Element[], account: Element[]): void {
  const achievementsFold = fold('Achievements', achievements);
  // The fold title shows the count, such as "12 of 51 unlocked", so the heading inside goes.
  achievementsFold.querySelector('summary h3')?.append(myGamesAchievementsSummary);
  const accountFold = fold('Account and data', account);
  const jump = (target: HTMLElement) => () => {
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const bar = part('my-games-jump', [
    button('Continue', jump(myGamesOnlineBox)),
    button('History', jump(sectionOf(myGamesHistory))),
    button('Achievements', jump(achievementsFold)),
    button('Account', jump(accountFold)),
  ]);
  head.after(bar, ...games, achievementsFold, accountFold);
}

// C: a full page. Two columns on a wide screen: you on the left, your games on the right.
function fullPage(head: Element, games: Element[], achievements: Element[], account: Element[]): void {
  myGamesDialog.classList.add('my-games-page');
  head.after(part('my-games-columns', [part('my-games-column', [...account, ...achievements]), part('my-games-column my-games-main', games)]));
}

export function applyMyGamesLayout(): void {
  const wanted = new URL(location.href).searchParams.get('mygames');
  const layout = LAYOUTS.find((known) => known === wanted);
  if (layout === undefined) return;
  const head = myGamesDialog.querySelector('.modal-head');
  const data = myGamesDialog.querySelector('.my-games-data');
  if (head === null || data === null) throw new Error('the My games dialog changed');
  myGamesDialog.dataset.layout = layout;
  // The achievements show as a grid of badges. A tap on a badge opens its row in place.
  myGamesAchievements.addEventListener('click', (event) => {
    const item = event.target instanceof Element ? event.target.closest('li') : null;
    if (item !== null) item.toggleAttribute('data-expanded');
  });
  const games = [myGamesOnlineBox, sectionOf(myGamesHistory), myGamesSessionBox, sectionOf(myGamesDevice), myGamesNote, myGamesStats];
  const achievements = [sectionOf(myGamesAchievements)];
  const account = [accountBox, myGamesPrivateOption, myGamesBlockedBox, data];
  const build: Record<Layout, typeof tabs> = { a: tabs, b: oneScroll, c: fullPage };
  build[layout](head, games, achievements, account);
}
