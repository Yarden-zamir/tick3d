// The store screenshot targets of targets.json and the scenes of scenes.json, checked. convert.py reads
// the same files. A target is one store slot: every scene renders once per target, at size / scale CSS
// pixels and scale.
import targetList from './targets.json' with { type: 'json' };
import sceneList from './scenes.json' with { type: 'json' };

type Target = {
  name: string;
  // ios adds the user agent mark of the iOS app, so the page hides what the App Store does not allow.
  platform: 'android' | 'ios';
  // The output size in pixels, width × height. It must be a size that the store accepts.
  size: readonly [number, number];
  scale: number;
  // The store gets the shot under its scene caption (caption.html). Play asks for no added text on
  // tablet and Chromebook shots, so those targets set false.
  caption: boolean;
  out: string;
};

type Scene = {
  // The file name of the shot in store.spec.ts, for example 1-tower. The list order is the store order.
  name: string;
  // The caption above the shot. [word] marks the word that caption.html highlights.
  caption: string;
};

function checkTarget(value: (typeof targetList)[number]): Target {
  const { name, platform, size, scale, caption, out } = value;
  if (platform !== 'android' && platform !== 'ios') throw new Error(`target ${name}: bad platform ${platform}`);
  const [width, height] = size;
  if (size.length !== 2 || width === undefined || height === undefined) throw new Error(`target ${name}: size is not [width, height]`);
  if (!Number.isInteger(width / scale) || !Number.isInteger(height / scale)) throw new Error(`target ${name}: size / scale is not whole CSS pixels`);
  return { name, platform, size: [width, height], scale, caption, out };
}

function checkScene({ name, caption }: (typeof sceneList)[number]): Scene {
  if (name === '' || name.includes('/')) throw new Error(`scene ${name}: the name is not a file name`);
  if (caption.trim() === '') throw new Error(`scene ${name}: no caption`);
  return { name, caption };
}

export const TARGETS: readonly Target[] = targetList.map(checkTarget);
export const SCENES: readonly Scene[] = sceneList.map(checkScene);
