// The store screenshot targets of targets.json, checked. convert.py reads the same file.
// A target is one store slot: every scene renders once per target, at size / scale CSS pixels and scale.
import list from './targets.json' with { type: 'json' };

type Target = {
  name: string;
  // ios adds the user agent mark of the iOS app, so the page hides what the App Store does not allow.
  platform: 'android' | 'ios';
  // The output size in pixels, width × height. It must be a size that the store accepts.
  size: readonly [number, number];
  scale: number;
  out: string;
};

function check(value: (typeof list)[number]): Target {
  const { name, platform, size, scale, out } = value;
  if (platform !== 'android' && platform !== 'ios') throw new Error(`target ${name}: bad platform ${platform}`);
  const [width, height] = size;
  if (size.length !== 2 || width === undefined || height === undefined) throw new Error(`target ${name}: size is not [width, height]`);
  if (!Number.isInteger(width / scale) || !Number.isInteger(height / scale)) throw new Error(`target ${name}: size / scale is not whole CSS pixels`);
  return { name, platform, size: [width, height], scale, out };
}

export const TARGETS: readonly Target[] = list.map(check);
