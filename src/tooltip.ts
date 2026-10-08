// A small tooltip for any element with a data-tip text. It shows on hover and on keyboard focus,
// and on a long press with touch. A long press does not count as a tap, so it never toggles the
// control. A short tap works as usual. While the tooltip shows, the element names it in aria-describedby.

const LONG_PRESS_MS = 500;
// A finger that moves more than this many pixels scrolls the page, so it is not a long press.
const MOVE_LIMIT_PX = 10;
const TOUCH_SHOW_MS = 2500;

let tip: HTMLDivElement | undefined;
let shownFor: HTMLElement | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

const tipTarget = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;

function place(box: HTMLDivElement, target: HTMLElement): void {
  const margin = 8;
  const anchor = target.getBoundingClientRect();
  const size = box.getBoundingClientRect();
  const left = Math.min(Math.max(margin, anchor.left + anchor.width / 2 - size.width / 2), innerWidth - size.width - margin);
  // Above the element, or below it when there is no room above.
  const above = anchor.top - size.height - margin;
  box.style.left = `${left}px`;
  box.style.top = `${above >= margin ? above : anchor.bottom + margin}px`;
}

function show(target: HTMLElement): void {
  const text = target.dataset.tip;
  if (tip === undefined || text === undefined || text === '') return;
  clearTimeout(hideTimer);
  if (shownFor !== undefined && shownFor !== target) shownFor.removeAttribute('aria-describedby');
  shownFor = target;
  tip.textContent = text;
  tip.hidden = false;
  target.setAttribute('aria-describedby', tip.id);
  place(tip, target);
}

function hide(): void {
  clearTimeout(hideTimer);
  if (tip !== undefined) tip.hidden = true;
  shownFor?.removeAttribute('aria-describedby');
  shownFor = undefined;
}

export function setupTooltips(): void {
  tip = document.createElement('div');
  tip.id = 'tip';
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);

  document.addEventListener('pointerover', (event) => {
    const target = tipTarget(event.target);
    if (event.pointerType === 'mouse' && target !== null) show(target);
  });
  document.addEventListener('pointerout', (event) => {
    const target = tipTarget(event.target);
    if (event.pointerType === 'mouse' && target !== null && target === shownFor && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) hide();
  });
  document.addEventListener('focusin', (event) => {
    const target = tipTarget(event.target);
    // Only a keyboard focus shows the tip. A tap also focuses the button, and a tap must not show it.
    if (target !== null && target.matches(':focus-visible')) show(target);
  });
  document.addEventListener('focusout', () => hide());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
  addEventListener('scroll', () => hide(), { passive: true, capture: true });
  // A render can replace the element under the tooltip (the Players box draws its buttons again on
  // every update). The removed element sends no pointerout or focusout, so its tooltip goes here.
  new MutationObserver(() => {
    if (shownFor !== undefined && !shownFor.isConnected) hide();
  }).observe(document.body, { childList: true, subtree: true });

  // Long press with touch (or a pen): the tooltip shows, and the click that ends the press is dropped.
  let press: { target: HTMLElement; x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined;
  let dropClickOn: HTMLElement | undefined;
  const endPress = () => {
    if (press !== undefined) clearTimeout(press.timer);
    press = undefined;
  };
  document.addEventListener('pointerdown', (event) => {
    endPress();
    dropClickOn = undefined;
    const target = tipTarget(event.target);
    // A long press on a person opens the report and block menu (src/page/safety.ts), not a tooltip.
    const onPerson = event.target instanceof Element && event.target.closest('[data-person]') !== null;
    if (event.pointerType === 'mouse' || target === null || onPerson) return;
    const timer = setTimeout(() => {
      show(target);
      dropClickOn = target;
      hideTimer = setTimeout(hide, TOUCH_SHOW_MS);
    }, LONG_PRESS_MS);
    press = { target, x: event.clientX, y: event.clientY, timer };
  });
  document.addEventListener('pointermove', (event) => {
    if (press !== undefined && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_LIMIT_PX) endPress();
  });
  document.addEventListener('pointerup', endPress);
  document.addEventListener('pointercancel', endPress);
  document.addEventListener(
    'click',
    (event) => {
      const drop = dropClickOn;
      dropClickOn = undefined;
      if (drop === undefined || !(event.target instanceof Node) || !drop.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );
  // A long press on a phone opens the system menu of the element. The tooltip replaces it.
  document.addEventListener('contextmenu', (event) => {
    if (tipTarget(event.target) !== null) event.preventDefault();
  });
}
