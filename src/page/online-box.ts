// The online box: share, QR code, join by code, session name, and the LAN host note.
import { DEVICE_ICONS } from '../nearby/device.ts';
import { EYE_ICON } from '../icons.ts';
import { renderQr } from '../nearby/qr.ts';
import { normalizeCode, type Code, normalizeName } from '../protocol.ts';
import { type LinkIntent, sessionLink } from '../session-link.ts';
import { sounds } from '../sound.ts';
import {
  lanHost,
  joinForm,
  joinCodeInput,
  newCodeButton,
  shareButton,
  shareQrButton,
  shareWatchButton,
  onlineQr,
  onlineQrCaption,
  onlineQrImage,
  sessionNameInput,
} from './dom.ts';
import { showToast, reject, showProblem } from './feedback.ts';
import { BUSY_TEXT, joinSession, createSession, withBusy, applyView } from './sessions.ts';
import { page, settingsLocked } from './state.ts';

// A LAN host (a laptop that runs the server for the local network) says so in the online box.
export async function checkLanHost(): Promise<void> {
  try {
    const response = await fetch('/api/health');
    const body: unknown = await response.json();
    const lan = typeof body === 'object' && body !== null && 'lan' in body ? body.lan : null;
    if (typeof lan === 'object' && lan !== null && 'name' in lan && typeof lan.name === 'string') {
      lanHost.hidden = false;
      lanHost.replaceChildren();
      const icon = document.createElement('span');
      icon.className = 'device-icon';
      icon.innerHTML = DEVICE_ICONS.server;
      const text = document.createElement('span');
      text.textContent = `Hosted on ${lan.name} on this network`;
      lanHost.append(icon, text);
    }
  } catch {
    // No server answers (offline, or a static preview). The online box stays as it is.
  }
}

async function shareLink(intent: LinkIntent): Promise<void> {
  if (page.session?.mode !== 'online') return;
  const url = sessionLink(location.origin, page.session.code, intent);
  const text = intent === 'watch' ? 'Watch my 3D tic-tac-toe game on tick3d.' : `Play 3D tic-tac-toe with me on tick3d. Code ${page.session.code}.`;
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'tick3d', text, url });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast(intent === 'watch' ? 'Watch link copied.' : 'Link copied.');
  } catch {
    showToast(`Send this link: ${url}`);
  }
}

// The game's link as a QR code: a friend's phone camera opens the online game directly.
let onlineQrShown: Code | undefined;
export function renderOnlineQr(code: Code | undefined): void {
  const open = shareQrButton.getAttribute('aria-expanded') === 'true' && code !== undefined;
  onlineQr.hidden = !open;
  if (!open || code === onlineQrShown) return;
  onlineQrShown = code;
  onlineQrCaption.textContent = `Scan with a phone camera to join ${code}.`;
  const link = sessionLink(location.origin, code, 'play');
  void renderQr(link).then((svg) => {
    if (onlineQrShown === code) onlineQrImage.replaceChildren(svg);
  });
}

export function setupOnlineBox(): void {
  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (settingsLocked()) return reject(undefined, 'locked');
    const code = normalizeCode(joinCodeInput.value);
    if (code === undefined) {
      showProblem('A code has 4 letters or digits.');
      return;
    }
    // Keep the typed code while another action runs, so the player can try again.
    if (page.busy) return showToast(BUSY_TEXT);
    joinCodeInput.value = '';
    void joinSession(code, 'play');
  });

  newCodeButton.addEventListener('click', () => {
    if (settingsLocked()) return reject(undefined, 'locked');
    sounds.click();
    void createSession();
  });

  shareButton.addEventListener('click', () => void shareLink('play'));
  shareWatchButton.insertAdjacentHTML('afterbegin', EYE_ICON);
  shareWatchButton.addEventListener('click', () => void shareLink('watch'));
  shareQrButton.addEventListener('click', () => {
    sounds.click();
    const open = shareQrButton.getAttribute('aria-expanded') !== 'true';
    shareQrButton.setAttribute('aria-expanded', String(open));
    renderOnlineQr(page.session?.mode === 'online' ? page.session.code : undefined);
  });

  sessionNameInput.addEventListener('change', () => {
    if (page.session === undefined) return;
    const name = normalizeName(sessionNameInput.value);
    if (name === undefined) {
      showProblem('A name needs 1 to 40 characters.');
      sessionNameInput.value = page.session.name;
      return;
    }
    const { code, backend } = page.session;
    void withBusy(async () => {
      applyView(await backend.update(code, { name }));
      showToast('Session renamed.');
    });
  });
}
