// The sound playoff on the game page: the prompt when the other player starts one, and the link to the
// Voice room that brings the other player along. The playoff itself runs in the Voice room (/sound-input).
import { OnlineError, api } from '../online.ts';
import type { SessionView } from '../protocol.ts';
import { element } from './dom.ts';
import { showToast } from './feedback.ts';
import { page } from './state.ts';

const dialog = element('#playoff-invite', HTMLDialogElement);
const text = element('#playoff-invite-text', HTMLParagraphElement);
const joinButton = element('#playoff-join', HTMLButtonElement);
const notNowButton = element('#playoff-not-now', HTMLButtonElement);
const voiceRoomLink = element('#voice-room-link', HTMLAnchorElement);

// The playoff that the prompt is for. A playoff gets one prompt, also when the session updates again.
let asked: { code: string; id: number } | undefined;

const playoffHref = (code: string) => `/sound-input?code=${encodeURIComponent(code)}`;

// Called with every new view of the session.
export function checkPlayoffInvite(view: SessionView): void {
  const { playoff, you } = view;
  const invited = playoff !== null && you !== null && playoff.ended === null && playoff.by !== you && !playoff.seats[you].joined;
  if (!invited) {
    if (dialog.open && asked?.code === view.code) dialog.close();
    return;
  }
  if (asked?.code === view.code && asked.id === playoff.id) return;
  asked = { code: view.code, id: playoff.id };
  const name = view.players[playoff.by]?.login ?? view.names[playoff.by] ?? 'The other player';
  text.textContent = `${name} started a sound playoff. Join to sing to the same targets at the same time.`;
  if (!dialog.open) dialog.showModal();
}

joinButton.addEventListener('click', () => {
  if (asked === undefined) return;
  location.assign(playoffHref(asked.code));
});

notNowButton.addEventListener('click', () => {
  dialog.close();
  const session = page.session;
  if (asked === undefined || session === undefined || session.code !== asked.code) return;
  api.playoff(session.code, { action: 'leave', id: asked.id }).catch((error: unknown) => {
    if (!(error instanceof OnlineError)) throw error;
    showToast(error.message, 'problem');
  });
});

// In a seated online game, the Voice room opens on its playoff tab for that game.
voiceRoomLink.addEventListener('click', () => {
  const session = page.session;
  voiceRoomLink.href = session !== undefined && session.mode === 'online' && session.you !== null ? playoffHref(session.code) : '/sound-input';
});
