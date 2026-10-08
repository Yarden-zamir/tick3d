// A click, a tap, Enter or Space on a person's picture opens it large, with the name.
// A long press opens the report and block menu (src/page/safety.ts) and drops the click that ends it,
// so it never also opens the viewer here. A right-click and Shift+F10 send no click.
import { type Person, VIEW_PIXELS, avatarImage, viewablePerson } from '../avatar.ts';
import { avatarViewer, avatarViewerClose, avatarViewerName, avatarViewerPicture } from './dom.ts';

function openViewer(person: Person): void {
  if (avatarViewer.open) return;
  avatarViewerPicture.replaceChildren(avatarImage(person, VIEW_PIXELS));
  avatarViewerName.textContent = person.name;
  avatarViewer.showModal();
  avatarViewerClose.focus();
}

export function setupAvatarViewer(): void {
  avatarViewerClose.addEventListener('click', () => avatarViewer.close());
  avatarViewer.addEventListener('click', (event) => {
    if (event.target === avatarViewer) avatarViewer.close();
  });
  document.addEventListener('click', (event) => {
    const person = viewablePerson(event.target);
    if (person === undefined) return;
    event.preventDefault();
    openViewer(person);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const person = viewablePerson(event.target);
    if (person === undefined) return;
    event.preventDefault();
    openViewer(person);
  });
}
