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
