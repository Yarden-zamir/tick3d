// The localStorage keys of the site. The page modules and the tests read them from here, so a
// renamed key cannot leave a test behind.
// Limit: src/voice/settings.ts and src/sound-input/practice-room.ts keep their own keys. Move them
// here when the open pull requests on those files merge.
export const STORAGE_KEYS = {
  settings: 'tick3d.settings',
  player: 'tick3d.player',
  records: 'tick3d.records',
  tuning: 'tick3d.tuning',
  name: 'tick3d.name',
  soundTraining: 'tick3d.sound-training',
  // The last block list from the server, so a game without a network still hides blocked people.
  blocks: 'tick3d.blocks',
  // The chat messages that this device reported, as "<code>:<id>". They stay hidden here.
  reported: 'tick3d.reported',
} as const;

// The keys that hold settings, not game data. 'tick3d.voice' is the key of src/voice/settings.ts
// (see the limit above). storage-keys.test.ts checks that this list holds it.
const SETTINGS_KEYS: readonly string[] = [STORAGE_KEYS.settings, STORAGE_KEYS.tuning, 'tick3d.voice'];

// The keys that Delete my data removes from this device: every key of the site except the player
// token, and except the settings when `resetSettings` is false. A key of the site starts with "tick3d.".
export function deviceDataKeys(keys: readonly string[], resetSettings: boolean): string[] {
  return keys.filter(
    (key) => key.startsWith('tick3d.') && key !== STORAGE_KEYS.player && (resetSettings || !SETTINGS_KEYS.includes(key)),
  );
}
