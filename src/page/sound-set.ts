// The sound set menu next to the Sound button: one row per set, with a button to choose it and a demo button.
import { playDemo, playSample, setSoundSet } from '../sound.ts';
import { SOUND_SET_GROUPS, SOUND_SETS, type SoundSetId } from '../sound-sets.ts';
import { soundSetList } from './dom.ts';
import { settings, saveSettings } from './settings.ts';

function option(id: SoundSetId): HTMLElement {
  const set = SOUND_SETS[id];
  const row = document.createElement('div');
  row.className = 'sound-set-option';
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'sound-set-choice';
  choose.dataset.soundSet = id;
  choose.setAttribute('aria-label', `Use the ${set.name} sound set: ${set.description}`);
  const name = document.createElement('b');
  name.textContent = set.name;
  const description = document.createElement('small');
  description.textContent = set.description;
  choose.append(name, description);
  choose.addEventListener('click', () => {
    settings.soundSet = id;
    saveSettings();
    applySoundSet();
    playSample(id);
  });
  const demo = document.createElement('button');
  demo.type = 'button';
  demo.className = 'sound-set-play';
  demo.textContent = '▶';
  demo.setAttribute('aria-label', `Play the ${set.name} demo`);
  demo.addEventListener('click', () => playDemo(id));
  row.append(choose, demo);
  return row;
}

// The sound set is a per-screen choice like the theme and the mute, so the settings lock does not hold it.
function applySoundSet(): void {
  setSoundSet(settings.soundSet);
  soundSetList.querySelectorAll<HTMLButtonElement>('[data-sound-set]').forEach((button) =>
    button.setAttribute('aria-pressed', String(button.dataset.soundSet === settings.soundSet)),
  );
}

export function setupSoundSets(): void {
  soundSetList.replaceChildren(
    ...Object.entries(SOUND_SET_GROUPS).map(([title, ids]) => {
      const group = document.createElement('section');
      group.className = 'sound-set-group';
      const heading = document.createElement('h3');
      heading.textContent = title;
      group.append(heading, ...ids.map(option));
      return group;
    }),
  );
  applySoundSet();
}
