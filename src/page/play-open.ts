// Chrome owns the player token. Request its bound nonce here, then let the native app attest it.
import { OnlineError, api } from '../online.ts';
import { isRecord } from '../guards.ts';

export function receivePlayOpen(): Promise<{ proof: string; referrer: string | null } | null> | undefined {
  const url = new URL(location.href);
  if (url.searchParams.get('playPurchase') !== '1') return undefined;
  url.searchParams.delete('playPurchase');
  history.replaceState(history.state, '', url);
  return new Promise((resolve, reject) => {
    let port: MessagePort | undefined;
    const close = () => {
      clearTimeout(timer);
      window.removeEventListener('message', connect);
      port?.close();
    };
    const connect = (event: MessageEvent<unknown>) => {
      // Chrome validates the app's use_as_origin relation and restricts delivery to this origin.
      if (event.origin !== location.origin || event.data !== 'tick3d.purchase' || event.ports[0] === undefined || port !== undefined) return;
      port = event.ports[0];
      const connected = port;
      connected.onmessage = (message: MessageEvent<unknown>) => {
        try {
          const result: unknown = typeof message.data === 'string' ? JSON.parse(message.data) : null;
          if (!isRecord(result) || typeof result.proof !== 'string' || (result.referrer !== null && typeof result.referrer !== 'string')) {
            throw new Error('invalid native Play purchase answer');
          }
          connected.postMessage('done');
          resolve({ proof: result.proof, referrer: result.referrer });
        } catch (error) {
          reject(error);
        } finally {
          close();
        }
      };
      void api.purchaseNonce().then((nonce) => connected.postMessage(nonce)).catch((error: unknown) => {
        close();
        if (error instanceof OnlineError) resolve(null);
        else reject(error);
      });
    };
    const timer = setTimeout(() => { close(); resolve(null); }, 65_000);
    window.addEventListener('message', connect);
  });
}
