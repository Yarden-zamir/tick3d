// A click, a tap, Enter or Space on a person's picture opens it large, with the name and a link to their stats.
// A long press opens the report and block menu (src/page/safety.ts) and drops the click that ends it,
// so it never also opens the viewer here. A right-click and Shift+F10 send no click.
import { VIEW_PIXELS, type Viewable, avatarImage, viewablePerson } from '../avatar.ts';
import { ALL_STATS, statsQuery } from '../protocol.ts';
import { avatarViewer, avatarViewerClose, avatarViewerName, avatarViewerPicture, avatarViewerStats } from './dom.ts';

// The stats page shows the message of a person who hides their stats (GET /api/stats answers 403).
function openViewer({ person, id }: Viewable): void {
  if (avatarViewer.open) return;
  avatarViewerPicture.replaceChildren(avatarImage(person, VIEW_PIXELS));
  avatarViewerName.textContent = person.name;
  avatarViewerStats.hidden = id === null;
  if (id === null) avatarViewerStats.removeAttribute('href');
  else avatarViewerStats.href = `/stats${statsQuery({ ...ALL_STATS, person: id })}`;
  avatarViewerStats.setAttribute('aria-label', `Stats of ${person.name}`);
  avatarViewer.showModal();
  avatarViewerClose.focus();
}

export function setupAvatarViewer(): void {
  avatarViewerClose.addEventListener('click', () => avatarViewer.close());
  avatarViewer.addEventListener('click', (event) => {
    if (event.target === avatarViewer) avatarViewer.close();
  });
  document.addEventListener('click', (event) => {
    const found = viewablePerson(event.target);
    if (found === undefined) return;
    event.preventDefault();
    openViewer(found);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const found = viewablePerson(event.target);
    if (found === undefined) return;
    event.preventDefault();
    openViewer(found);
  });
}
