// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { toEpochMs } from '../epoch.ts';
import type { Player } from '../game.ts';
import type { ChatMessage } from '../protocol.ts';
import { chatGroups } from './chat-log.ts';

const message = (id: number, from: Player, text: string): ChatMessage => ({ id, from, text, at: toEpochMs(1_700_000_000_000 + id) });
const sender = (seat: Player) => ({ label: seat === 'X' ? 'You' : 'braveOtter', person: { player: null, name: seat === 'X' ? 'calmHeron' : 'braveOtter' } });

describe('chat log', () => {
  it('shows one picture and one name for each run of messages from one sender', () => {
    const messages = [message(1, 'X', 'hi'), message(2, 'X', 'ready?'), message(3, 'O', 'yes'), message(4, 'X', 'go')];
    const groups = chatGroups(messages, sender, 'X');
    expect(groups).toHaveLength(3);
    for (const group of groups) expect(group.querySelectorAll('img.avatar')).toHaveLength(1);
    expect(groups.map((group) => group.querySelectorAll('.chat-message').length)).toEqual([2, 1, 1]);
    expect(groups.map((group) => group.querySelector('b')?.textContent)).toEqual(['You', 'braveOtter', 'You']);
    expect(groups.map((group) => group.classList.contains('mine'))).toEqual([true, false, true]);
  });

  it('gives a sender the same picture in every group', () => {
    const groups = chatGroups([message(1, 'X', 'a'), message(2, 'O', 'b'), message(3, 'X', 'c')], sender, null);
    const pictures = groups.map((group) => group.querySelector('img')?.src);
    expect(pictures[0]).toBe(pictures[2]);
    expect(pictures[0]).not.toBe(pictures[1]);
  });
});
