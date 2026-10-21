// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnlineError, api } from '../online.ts';
import { receivePlayOpen } from './play-open.ts';

function port() {
  return { postMessage: vi.fn(), close: vi.fn(), onmessage: undefined as ((message: MessageEvent<unknown>) => void) | undefined };
}
function connect(channel: ReturnType<typeof port>, origin = location.origin) {
  window.dispatchEvent(new MessageEvent('message', { origin, data: 'tick3d.purchase', ports: [channel as unknown as MessagePort] }));
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('the native Play purchase handoff', () => {
  it('gets the browser player nonce and passes the signed proof back without changing its identity', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/?playPurchase=1&code=AB3K');
    const nonce = vi.spyOn(api, 'purchaseNonce').mockResolvedValue('player-bound-nonce');
    const channel = port();
    const opened = receivePlayOpen();
    expect(location.search).toBe('?code=AB3K');
    connect(channel, 'https://other.example');
    expect(nonce).not.toHaveBeenCalled();
    connect(channel);
    await vi.waitFor(() => expect(channel.postMessage).toHaveBeenCalledWith('player-bound-nonce'));
    channel.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ proof: 'signed-proof', referrer: 'by=0123456789abcdef' }) }));
    await expect(opened).resolves.toEqual({ proof: 'signed-proof', referrer: 'by=0123456789abcdef' });
    expect(channel.postMessage).toHaveBeenCalledWith('done');
    expect(channel.close).toHaveBeenCalledOnce();
  });
  it.each([undefined, 403, 503])('leaves play alone when the nonce request fails (%s)', async (status) => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/?playPurchase=1');
    vi.spyOn(api, 'purchaseNonce').mockRejectedValue(new OnlineError('unavailable', status));
    const opened = receivePlayOpen();
    const channel = port();
    connect(channel);
    await expect(opened).resolves.toBeNull();
    expect(channel.postMessage).not.toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalledOnce();
  });
  it('opens without a proof when the browser has no message channel', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/?playPurchase=1');
    const opened = receivePlayOpen();
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(opened).resolves.toBeNull();
    expect(receivePlayOpen()).toBeUndefined();
  });
});
