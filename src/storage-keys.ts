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
} as const;
