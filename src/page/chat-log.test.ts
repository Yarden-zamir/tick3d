// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { toEpochMs } from '../epoch.ts';
import type { Player } from '../game.ts';
import type { ChatMessage, PersonId } from '../protocol.ts';
import { type Sender, chatGroups } from './chat-log.ts';

const ME = '000000000000000a' as PersonId;
const BOB = '000000000000000b' as PersonId;
const message = (id: number, from: Player, text: string, by?: PersonId): ChatMessage => ({ id, from, text, at: toEpochMs(1_700_000_000_000 + id), ...(by === undefined ? {} : { by }) });
// A sender by person id: this screen is ME, the other player is BOB. Seat X is ME without a person id.
const sender = (entry: ChatMessage): Sender => {
  const mine = (entry.by ?? (entry.from === 'X' ? ME : BOB)) === ME;
  return { label: mine ? 'You' : 'braveOtter', person: { player: null, name: mine ? 'calmHeron' : 'braveOtter' }, id: entry.by ?? null, mine };
};

describe('chat log', () => {
  it('shows one picture and one name for each run of messages from one sender', () => {
    const messages = [message(1, 'X', 'hi'), message(2, 'X', 'ready?'), message(3, 'O', 'yes'), message(4, 'X', 'go')];
    const groups = chatGroups(messages, sender);
    expect(groups).toHaveLength(3);
    for (const group of groups) expect(group.querySelectorAll('img.avatar')).toHaveLength(1);
    expect(groups.map((group) => group.querySelectorAll('.chat-message').length)).toEqual([2, 1, 1]);
    expect(groups.map((group) => group.querySelector('b')?.textContent)).toEqual(['You', 'braveOtter', 'You']);
    expect(groups.map((group) => group.classList.contains('mine'))).toEqual([true, false, true]);
  });

  it('gives a sender the same picture in every group', () => {
    const groups = chatGroups([message(1, 'X', 'a'), message(2, 'O', 'b'), message(3, 'X', 'c')], sender);
    const pictures = groups.map((group) => group.querySelector('img')?.src);
    expect(pictures[0]).toBe(pictures[2]);
    expect(pictures[0]).not.toBe(pictures[1]);
  });

  it('keeps the messages of one person together after a seat change, and marks the other person for the menu', () => {
    // Bob wrote as O, then as X after a swap: one group, by his person id.
    const groups = chatGroups([message(1, 'O', 'hi', BOB), message(2, 'X', 'swap done', BOB), message(3, 'O', 'ok', ME)], sender);
    expect(groups.map((group) => group.querySelectorAll('.chat-message').length)).toEqual([2, 1]);
    const marked = groups[0]?.querySelector<HTMLElement>('.chat-message');
    expect(marked?.dataset).toMatchObject({ person: BOB, personName: 'braveOtter', message: '1' });
    expect(marked?.tabIndex).toBe(0);
    expect(groups[1]?.querySelector<HTMLElement>('.chat-message')?.dataset.person).toBeUndefined();
  });
});
