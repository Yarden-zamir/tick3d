// Google One Tap: Google's standard sign-in prompt on the web (Google Identity Services). A player who
// is signed in to Google in the browser sees "Continue as …", and a returning player is signed in
// automatically. The Android app is this site in Chrome (a Trusted Web Activity), so it gets the same
// prompt from the Google accounts of the phone. Chrome shows it through FedCM, its own sign-in sheet.
import { api } from '../online.ts';
import { platform } from '../platform.ts';
import { loggedIn, page } from './state.ts';

const SCRIPT = 'https://accounts.google.com/gsi/client';

// The part of the Google Identity Services API that the page uses
// (https://developers.google.com/identity/gsi/web/reference/js-reference).
type GoogleIdentity = {
  initialize(config: {
    client_id: string;
    callback: (response: { credential?: string }) => void;
    auto_select: boolean;
    cancel_on_tap_outside: boolean;
    use_fedcm_for_prompt: boolean;
    itp_support: boolean;
  }): void;
  prompt(): void;
  disableAutoSelect(): void;
};
declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentity } };
  }
}

let loaded: Promise<GoogleIdentity> | undefined;

function loadScript(): Promise<GoogleIdentity> {
  loaded ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.addEventListener('load', () => {
      const identity = window.google?.accounts?.id;
      if (identity === undefined) reject(new Error('Google sign-in did not load'));
      else resolve(identity);
    });
    script.addEventListener('error', () => reject(new Error('Google sign-in did not load')));
    document.head.append(script);
  });
  return loaded;
}

// Shows the prompt to a player without a login. A sign-in reloads the page, as after a GitHub login,
// because the account changes the games, stats and records that the page shows.
// Without a network, on iOS (no login there), or on a page that Google does not accept, it does nothing.
export async function offerGoogleOneTap(onError: (error: unknown) => void): Promise<void> {
  const client = page.account.googleOneTapClient;
  if (client === null || loggedIn() || platform() !== 'web' || !navigator.onLine) return;
  const identity = await loadScript();
  identity.initialize({
    client_id: client,
    callback: ({ credential }) => {
      if (credential === undefined) return;
      api.googleOneTap(credential).then(() => location.reload(), onError);
    },
    auto_select: true,
    cancel_on_tap_outside: true,
    use_fedcm_for_prompt: true,
    itp_support: true,
  });
  identity.prompt();
}

// Call it before every logout: after it, One Tap asks again and does not sign the player in by itself.
// Every logout, because this browser may have signed in with Google before, also with another account.
// Google keeps this choice in a cookie of its own.
export async function stopGoogleAutoSelect(): Promise<void> {
  if (page.account.googleOneTapClient === null) return;
  (await loadScript()).disableAutoSelect();
}
