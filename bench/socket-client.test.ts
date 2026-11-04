import { describe, expect, it } from 'vitest';
import { socketOf } from './socket-client.ts';

// A socket with browser semantics: a send on a closed socket does nothing, and the test drives open, close and messages.
class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  send(text: string): void {
    if (this.readyState === WebSocket.OPEN) this.sent.push(text);
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
}

async function opened() {
  const fake = new FakeSocket();
  const client = socketOf('ws://test/api/ws', () => fake as unknown as WebSocket);
  fake.readyState = WebSocket.OPEN;
  fake.onopen?.();
  return { fake, client: await client };
}

describe('the bench socket client', () => {
  it('rejects pending and later calls once the socket closed, instead of leaving them pending', async () => {
    const { fake, client } = await opened();
    const pending = client.act('POST', '/sessions/AB12/moves', {});
    const waiting = client.until('AB12', 3);
    fake.close();
    await expect(pending).rejects.toThrow('closed during the run');
    await expect(waiting).rejects.toThrow('closed during the run');
    // After the close: a new action and a new wait fail at once.
    await expect(client.act('POST', '/sessions/AB12/moves', {})).rejects.toThrow('closed during the run');
    await expect(client.until('AB12', 4)).rejects.toThrow('closed during the run');
  });

  it('rejects an action whose answer is not 200', async () => {
    const { fake, client } = await opened();
    const answer = client.act('POST', '/sessions/AB12/moves', {});
    fake.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ id: 1, status: 409, body: { error: 'The board changed.' } }) }));
    await expect(answer).rejects.toThrow('409');
  });

  it('answers a wait for a version that it saw already', async () => {
    const { fake, client } = await opened();
    fake.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ code: 'AB12', view: { code: 'AB12', version: 5 } }) }));
    await expect(client.until('AB12', 5)).resolves.toBeUndefined();
  });
});
