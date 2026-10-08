// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { type PersonId, type SessionView, parseSessionView } from '../protocol.ts';
import { authorOf, markPerson, personTarget, visibleMessages } from './person-mark.ts';

const ALICE = 'aaaaaaaaaaaaaaaa' as PersonId;
const BOB = 'bbbbbbbbbbbbbbbb' as PersonId;

// Bob wrote as O. The seats then swapped: Bob holds X now. Message 3 is from before person ids.
function view(people: Record<'X' | 'O', PersonId | null>): SessionView {
  return parseSessionView({
    code: 'AB3K',
    name: 'Match',
    games: [{ moves: [], times: [], clock: { perMove: null, perGame: null }, timedOut: false }],
    seats: { X: true, O: true },
    you: 'O',
    options: { hideBoard: false, hideHistory: false, hideCoordinates: false },
    locked: false,
    clock: { perMove: null, perGame: null },
    now: 1,
    version: 1,
    chat: [
      { id: 1, from: 'O', text: 'hi', at: 1, by: BOB },
      { id: 2, from: 'X', text: 'hello', at: 2, by: ALICE },
      { id: 3, from: 'X', text: 'old one', at: 3 },
    ],
    presence: { X: true, O: true },
    players: { X: null, O: null },
    people,
  });
}

describe('the messages to show', () => {
  it('hides the messages of a blocked author after the author changes seats', () => {
    const swapped = view({ X: BOB, O: ALICE });
    expect(visibleMessages(swapped, new Set([BOB]), new Set()).map((message) => message.id)).toEqual([2]);
    expect(visibleMessages(swapped, new Set([ALICE]), new Set()).map((message) => message.id)).toEqual([1, 3]);
  });

  it('gives a message without a person id to the holder of its seat now', () => {
    const swapped = view({ X: BOB, O: ALICE });
    expect(swapped.chat.map((message) => authorOf(swapped, message))).toEqual([BOB, ALICE, BOB]);
  });

  it('hides a message that this device reported', () => {
    expect(visibleMessages(view({ X: ALICE, O: BOB }), new Set(), new Set(['AB3K:1'])).map((message) => message.id)).toEqual([2, 3]);
  });
});

describe('person marks', () => {
  it('make an element focusable and give back its target', () => {
    const element = document.createElement('span');
    const inner = document.createElement('b');
    element.append(inner);
    markPerson(element, { person: BOB, name: 'braveOtter', message: 4 });
    expect(element.tabIndex).toBe(0);
    expect(personTarget(inner)).toEqual({ element, target: { person: BOB, name: 'braveOtter', message: 4 } });
    expect(personTarget(document.createElement('div'))).toBeUndefined();
  });
});
