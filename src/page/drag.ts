// The rule for where a press in the stage starts a turn of the tower.

// A control in the stage keeps its own press: the keypad form, a button that is not a board cell,
// a field and a link. A press on a board cell, on the board or on the empty stage starts a drag.
const OWN_PRESS = '.coords, button:not(.cell), input, textarea, select, a, summary, label';

export function startsDrag(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OWN_PRESS) === null;
}
