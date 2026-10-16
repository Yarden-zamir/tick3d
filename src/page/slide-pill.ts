// The choice of a segmented control (Opponent, Difficulty, View and the like), of the Hide steps and of the
// time picks is a pill that slides from the old choice to the new one, instead of a background that jumps.
// One pill per group, under the buttons. It follows aria-pressed (and .active of a custom time, and the
// data-level of Hide), so it needs no call from render(). A resize moves it at once, with no slide.
import { element } from './dom.ts';

const GROUPS = '.segmented, .hide-steps, .limit-options';

// What the pill covers: one button, or for Hide the steps from History to the chosen one.
type Cover = { from: HTMLElement; to: HTMLElement; tone: 'ink' | 'toggle' };

function coverOf(group: HTMLElement): Cover | null {
  if (group.classList.contains('hide-steps')) {
    const level = Number(group.dataset.level ?? 0);
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[data-hide-level]')];
    const off = buttons[0];
    const history = buttons[1];
    const chosen = buttons[level];
    if (off === undefined || history === undefined || chosen === undefined) return null;
    return level === 0 ? { from: off, to: off, tone: 'ink' } : { from: history, to: chosen, tone: 'toggle' };
  }
  const chosen = group.querySelector<HTMLElement>(':scope > [aria-pressed="true"], :scope > .limit-custom.active');
  return chosen === null ? null : { from: chosen, to: chosen, tone: 'ink' };
}

function place(group: HTMLElement, pill: HTMLElement, instant: boolean): void {
  const cover = coverOf(group);
  pill.hidden = cover === null || group.offsetWidth === 0;
  if (cover === null || pill.hidden) return;
  pill.toggleAttribute('data-instant', instant);
  pill.dataset.tone = cover.tone;
  const left = cover.from.offsetLeft;
  pill.style.translate = `${left}px ${cover.from.offsetTop}px`;
  pill.style.width = `${cover.to.offsetLeft + cover.to.offsetWidth - left}px`;
  pill.style.height = `${cover.from.offsetHeight}px`;
}

export function setupSlidePills(): void {
  // The panel must exist; the groups in it are many, so one lookup proves the page is the game page.
  const root = element('.panels', HTMLElement);
  for (const group of root.querySelectorAll<HTMLElement>(GROUPS)) {
    const pill = document.createElement('span');
    pill.className = 'slide-pill';
    pill.setAttribute('aria-hidden', 'true');
    group.prepend(pill);
    group.classList.add('has-pill');
    place(group, pill, true);
    new MutationObserver(() => place(group, pill, false)).observe(group, {
      attributes: true,
      subtree: true,
      attributeFilter: ['aria-pressed', 'class', 'data-level'],
    });
    new ResizeObserver(() => place(group, pill, true)).observe(group);
  }
}
