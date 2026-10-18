// The people that an inviter brought to the game (the invite achievements of src/achievements.ts).
import type { EpochMs } from '../src/epoch.ts';

// One event that got the game to somebody through an invite: a claimed tester code, or an open of the Android app.
// `keys` name the human behind it: the device token and the owner (account or device) at the time of the event,
// and the email of a claim. Events that share a key belong to one person.
export type InviteEvent = { keys: readonly string[]; at: EpochMs };

// The first time of each person, after merging the events that share a key (a small union-find).
// A claim in the browser and a later app open on the same phone share the device token, and two devices of one
// account share the owner, so each counts once.
export function peopleOf(events: readonly InviteEvent[]): EpochMs[] {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const up = parent.get(key);
    if (up === undefined || up === key) return key;
    const root = find(up);
    parent.set(key, root);
    return root;
  };
  const firstKey = (event: InviteEvent): string => {
    const [first] = event.keys;
    if (first === undefined) throw new Error('an invite event has no key');
    return first;
  };
  for (const event of events) {
    const root = find(firstKey(event));
    for (const key of event.keys) {
      const other = find(key);
      if (other !== root) parent.set(other, root);
    }
  }
  const first = new Map<string, EpochMs>();
  for (const event of events) {
    const root = find(firstKey(event));
    const known = first.get(root);
    if (known === undefined || event.at < known) first.set(root, event.at);
  }
  return [...first.values()];
}
