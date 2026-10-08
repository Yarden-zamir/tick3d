// On a phone the chat, the board and the header sit above the settings panel. When one of them
// changes its height while the player works in the panel (a new mode opens the chat, the status wraps),
// the page scrolls by the same amount, so the panel stays still on the screen.
// Safari has no CSS scroll anchoring, and Chrome anchors to the first node in view, often the board.
// So the page keeps the panel in place itself, and src/style.css turns the browser anchoring off for this page.
// Limit: outside the panel nothing keeps the view, also in Chrome. Late content keeps its box instead (see .score:empty).
// Revisit if a change above the board starts to move the view while the player looks at the board.
// On a wide screen the panel has its own column and does not move.
import { element } from './dom.ts';

export function setupPanelAnchor(): void {
  const panel = element('.panel', HTMLElement);
  const above = [element('.brand', HTMLElement), element('#stage', HTMLElement), element('#chat', HTMLElement)];
  // True when the last press or focus was in the panel: the player looks at the settings, not at the board.
  let inPanel = false;
  // The top of the panel on the page, not in the viewport, so a scroll does not change it.
  const pageTop = () => panel.getBoundingClientRect().top + scrollY;
  let last = pageTop();
  const follow = (event: Event) => {
    inPanel = event.target instanceof Node && panel.contains(event.target);
  };
  document.addEventListener('pointerdown', follow, { capture: true, passive: true });
  document.addEventListener('focusin', follow);
  // A ResizeObserver runs after the layout and before the paint, so the player never sees the jump.
  const observer = new ResizeObserver(() => {
    const now = pageTop();
    const moved = now - last;
    last = now;
    // The panel was in view before the change: its old top in the viewport is above the bottom of the screen.
    if (inPanel && moved !== 0 && now - moved - scrollY < innerHeight) scrollBy(0, moved);
  });
  for (const node of above) observer.observe(node);
}
