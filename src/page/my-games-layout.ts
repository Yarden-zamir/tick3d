// The tabs of My games (issue #210): Games, Achievements and Account. Each tab shows its own sections
// of the dialog, so the lists and buttons work as before.
// Limit: the tabs move the sections of index.html when the page starts, and all of them load when the
// dialog opens. Revisit this when the redesign moves the sections into the tabs in index.html.
import {
  accountBox,
  myGamesAchievements,
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

const sectionOf = (child: Element): HTMLElement => {
  const section = child.closest('section');
  if (section === null) throw new Error('a My games list is outside its section');
  return section;
};

function panel(children: readonly Element[]): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'my-games-panel';
  box.setAttribute('role', 'tabpanel');
  box.append(...children);
  return box;
}

const TABS = ['Games', 'Achievements', 'Account'] as const;
export type MyGamesTab = (typeof TABS)[number];

let show: (tab: MyGamesTab) => void = () => {
  throw new Error('the My games tabs are not set up');
};

export const showMyGamesTab = (tab: MyGamesTab): void => show(tab);

export function setupMyGamesTabs(): void {
  const head = myGamesDialog.querySelector('.modal-head');
  const data = myGamesDialog.querySelector('.my-games-data');
  if (head === null || data === null) throw new Error('the My games dialog changed');
  const panels = [
    panel([myGamesOnlineBox, sectionOf(myGamesHistory), myGamesSessionBox, sectionOf(myGamesDevice), myGamesNote, myGamesStats]),
    panel([sectionOf(myGamesAchievements)]),
    panel([accountBox, myGamesPrivateOption, myGamesBlockedBox, data]),
  ];
  const bar = document.createElement('div');
  bar.className = 'my-games-tabs';
  bar.setAttribute('role', 'tablist');
  const tabs = TABS.map((label) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'btn btn-small';
    tab.textContent = label;
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => show(label));
    return tab;
  });
  show = (wanted) => {
    for (const [index, label] of TABS.entries()) {
      const box = panels[index];
      const tab = tabs[index];
      if (box === undefined || tab === undefined) throw new Error('a My games tab has no panel');
      box.hidden = label !== wanted;
      tab.setAttribute('aria-selected', String(label === wanted));
    }
  };
  bar.append(...tabs);
  head.after(bar, ...panels);
  show('Games');
  // The achievements show as a grid of badges. A tap on a badge opens its row in place.
  myGamesAchievements.addEventListener('click', (event) => {
    const item = event.target instanceof Element ? event.target.closest('li') : null;
    if (item !== null) item.toggleAttribute('data-expanded');
  });
}
