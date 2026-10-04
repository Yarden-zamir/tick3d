// Test helper: two connected in-memory channels, used in place of a WebRTC data channel.
import type { Channel } from './peer.ts';

// Two connected in-memory channels. Messages pass through JSON, as on a real data channel.
export function channelPair(): [Channel, Channel] {
  type Side = { messages: ((message: unknown) => void)[]; closes: (() => void)[]; closed: boolean };
  const sides: [Side, Side] = [
    { messages: [], closes: [], closed: false },
    { messages: [], closes: [], closed: false },
  ];
  const closeBoth = () => {
    for (const side of sides) {
      if (side.closed) continue;
      side.closed = true;
      for (const handler of side.closes) handler();
    }
  };
  const make = (self: Side, other: Side): Channel => ({
    send(message) {
      if (self.closed) throw new Error('closed');
      const copy: unknown = JSON.parse(JSON.stringify(message));
      queueMicrotask(() => {
        if (other.closed) return;
        for (const handler of other.messages) handler(copy);
      });
    },
    onMessage(handler) {
      self.messages.push(handler);
    },
    onClose(handler) {
      self.closes.push(handler);
    },
    close: closeBoth,
  });
  return [make(sides[0], sides[1]), make(sides[1], sides[0])];
}

