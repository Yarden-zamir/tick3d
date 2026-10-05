import { describe, expect, it, vi } from 'vitest';
import { wrapChannel } from './peer.ts';

// The parts of a data channel and a peer connection that wrapChannel uses.
function fakeConnection() {
  const dc = {
    readyState: 'open',
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    close: vi.fn(),
    send: vi.fn(),
  };
  const pc = { connectionState: 'connected', addEventListener: vi.fn(), close: vi.fn() };
  const channel = wrapChannel(dc as unknown as RTCDataChannel, pc as unknown as RTCPeerConnection);
  const receive = (data: unknown) => dc.onmessage?.({ data });
  return { channel, receive, pc };
}

describe('wrapChannel', () => {
  it('joins a message from its parts', () => {
    const { channel, receive } = fakeConnection();
    const messages: unknown[] = [];
    channel.onMessage((message) => messages.push(message));
    receive('P{"a":');
    receive('E1}');
    expect(messages).toEqual([{ a: 1 }]);
  });

  it.each([
    ['an empty part', ['P']],
    ['an empty last part', ['P{"a":', 'E']],
    ['a frame of unknown kind', ['X{}']],
    ['a whole message between parts', ['P{"a":', 'M{}']],
  ])('closes the connection on %s', (_, frames) => {
    const { channel, receive, pc } = fakeConnection();
    const closed = vi.fn();
    channel.onClose(closed);
    for (const frame of frames) receive(frame);
    expect(closed).toHaveBeenCalledOnce();
    expect(pc.close).toHaveBeenCalled();
  });
});
