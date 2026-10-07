// A sideways drag anywhere in the stage turns the tower. The game and the Voice room use it.
// The tower only turns around its vertical axis: the tilt stays at the resting view.
import { wrapSpin } from '../page/settings.ts';
import { startsDrag } from './starts-drag.ts';

// Degrees of turn per pixel dragged sideways.
const DRAG_SPIN = 0.4;
// A press counts as a drag after this many pixels sideways, so a tap still places a mark.
const DRAG_THRESHOLD = 6;

type SpinDrag = {
  // True when a drag can start now (the tower shows).
  active: () => boolean;
  spin: () => number;
  // A new spin during the drag, at most once per frame.
  turn: (spin: number) => void;
  // The drag starts to move, and the drag ends after a move.
  started: () => void;
  ended: () => void;
};

type Drag = { pointer: number; x: number; spin: number; moved: boolean };

export function setupSpinDrag(stage: HTMLElement, { active, spin, turn, started, ended }: SpinDrag): void {
  let drag: Drag | undefined;
  let frame = 0;
  let latest = 0;
  // The click that ends a drag must not place a mark.
  let swallowClick = false;

  const end = (event: PointerEvent) => {
    if (drag === undefined || event.pointerId !== drag.pointer) return;
    if (drag.moved) {
      // A click follows pointerup in the same task, or not at all. Either way the flag ends here.
      swallowClick = event.type === 'pointerup';
      setTimeout(() => (swallowClick = false));
      delete stage.dataset.dragging;
      ended();
    }
    drag = undefined;
  };

  // A drag starts anywhere in the stage, so the player does not have to hit the narrow tower.
  stage.addEventListener('pointerdown', (event) => {
    if (!active() || !event.isPrimary || event.button !== 0 || !startsDrag(event.target)) return;
    drag = { pointer: event.pointerId, x: event.clientX, spin: spin(), moved: false };
  });

  stage.addEventListener('pointermove', (event) => {
    if (drag === undefined || event.pointerId !== drag.pointer) return;
    // The button came up outside the stage, where pointerup does not reach it.
    if (event.buttons === 0) return end(event);
    const dx = event.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      drag.moved = true;
      stage.dataset.dragging = '';
      stage.setPointerCapture(event.pointerId);
      started();
    }
    latest = wrapSpin(drag.spin + dx * DRAG_SPIN);
    // One style update per frame, however fast the pointer events come.
    if (frame === 0) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        turn(latest);
      });
    }
  });

  stage.addEventListener('pointerup', end);
  // The browser takes over a touch that turns into a vertical scroll.
  stage.addEventListener('pointercancel', end);

  stage.addEventListener(
    'click',
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
}
