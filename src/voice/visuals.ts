// The look of voice input on a board, the same in the Voice room (/sound-input) and the game. visuals.css
// draws it on the cells of src/board/:
// - The light: the cell of the voice lifts and takes the win color at once.
// - The trail: a cell that loses the light fades back slowly, so a slide leaves a short trail.
// - The hold fill: while the player holds a note, the color of the mark fills the lit cell from its border
//   in, until the hold places the mark. A cell with a mark shows no fill.
// - The burst: a mark that the voice placed pops, and a ring flies out.
// The page keeps its own rules: it says which cell is lit, how far the hold is, and when a mark lands.
// Reduced motion: style.css stops the trail and the burst. The hold fill stays, because it is the only
// sign of the hold time, and it grows with the hold and does not move.
import './visuals.css';

// `share` is the part of the hold time that passed, from 0 to 1. `mark` is the mark that the hold places.
export type HoldFill = { share: number; mark: 'X' | 'O' };

export type VoiceCells = {
  // Lights `cell`, or puts the light out (null). `hold` fills the lit cell, or null for no fill.
  show(cell: number | null, hold: HoldFill | null): void;
  // A mark that the voice placed on `cell`.
  burst(cell: number): void;
};

// The fade of the trail in visuals.css.
const TRAIL_MS = 700;

export function createVoiceCells(cells: readonly HTMLElement[]): VoiceCells {
  let lit: HTMLElement | undefined;
  const trails = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const cellAt = (cell: number): HTMLElement => {
    const element = cells[cell];
    if (element === undefined) throw new RangeError(`no cell ${cell}`);
    return element;
  };

  const putOut = (element: HTMLElement): void => {
    element.classList.remove('lit', 'voice-hold');
    element.style.removeProperty('--voice-hold');
    delete element.dataset.voiceMark;
    element.classList.add('voice-trail');
    clearTimeout(trails.get(element));
    trails.set(
      element,
      setTimeout(() => {
        element.classList.remove('voice-trail');
        trails.delete(element);
      }, TRAIL_MS),
    );
  };

  return {
    show(cell, hold) {
      const next = cell === null ? undefined : cellAt(cell);
      if (next !== lit) {
        if (lit !== undefined) putOut(lit);
        lit = next;
        if (next !== undefined) {
          clearTimeout(trails.get(next));
          trails.delete(next);
          next.classList.remove('voice-trail');
          next.classList.add('lit');
        }
      }
      if (next === undefined) return;
      next.classList.toggle('voice-hold', hold !== null);
      if (hold === null) {
        next.style.removeProperty('--voice-hold');
        delete next.dataset.voiceMark;
        return;
      }
      next.style.setProperty('--voice-hold', String(Math.min(1, Math.max(0, hold.share))));
      next.dataset.voiceMark = hold.mark;
    },
    burst(cell) {
      const element = cellAt(cell);
      element.classList.remove('voice-burst');
      // Read the layout, so the animation starts again on a second burst of the same cell.
      void element.offsetWidth;
      element.classList.add('voice-burst');
      // The class goes at the end, so a board that shows again (Hide board) does not play the burst again.
      const end = (event: AnimationEvent) => {
        if (event.animationName !== 'voice-burst') return;
        element.classList.remove('voice-burst');
        element.removeEventListener('animationend', end);
      };
      element.addEventListener('animationend', end);
    },
  };
}
