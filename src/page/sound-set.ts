// The sound set menu: one row per set, with a button to choose it and a demo button.
// The game page and the ear training page (/sound-training) both use it.
import { PLAY_ICON } from '../icons.ts';
import { playDemo, playSample } from '../sound.ts';
import { SOUND_SET_GROUPS, SOUND_SETS, type SoundSetId } from '../sound-sets.ts';
import { settings, saveSettings } from './settings.ts';

function option(id: SoundSetId, choose: (id: SoundSetId) => void): HTMLElement {
  const set = SOUND_SETS[id];
  const row = document.createElement('div');
  row.className = 'sound-set-option';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-small sound-set-choice';
  button.dataset.soundSet = id;
  button.setAttribute('aria-label', `Use the ${set.name} sound set: ${set.description}`);
  const name = document.createElement('b');
  name.textContent = set.name;
  const description = document.createElement('small');
  description.textContent = set.description;
  button.append(name, description);
  button.addEventListener('click', () => choose(id));
  const demo = document.createElement('button');
  demo.type = 'button';
  demo.className = 'btn btn-small btn-icon sound-set-play';
  demo.innerHTML = PLAY_ICON;
  demo.setAttribute('aria-label', `Play the ${set.name} demo`);
  demo.addEventListener('click', () => playDemo(id));
  row.append(button, demo);
  return row;
}

// Fills `list` with the menu. `use` applies a set to the page: once at the start, and again after each choice.
// The sound set is a per-screen choice like the theme and the mute, so the settings lock does not hold it.
export function setupSoundSets(list: HTMLElement, use: (id: SoundSetId) => void): void {
  const apply = () => {
    use(settings.soundSet);
    list.querySelectorAll<HTMLButtonElement>('[data-sound-set]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.soundSet === settings.soundSet)),
    );
  };
  const choose = (id: SoundSetId) => {
    settings.soundSet = id;
    saveSettings();
    apply();
    playSample(id);
  };
  list.replaceChildren(
    ...SOUND_SET_GROUPS.map(({ title, subtitle, ids }) => {
      const group = document.createElement('section');
      group.className = 'sound-set-group';
      const heading = document.createElement('h3');
      heading.textContent = title;
      const note = document.createElement('p');
      note.textContent = subtitle;
      group.append(heading, note, ...ids.map((id) => option(id, choose)));
      return group;
    }),
  );
  apply();
}
