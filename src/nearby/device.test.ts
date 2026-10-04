import { describe, expect, it } from 'vitest';
import { DEVICE_ICONS, detectDevice, deviceLabel } from './device.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
// An iPad asks for the desktop site, so its user agent says Macintosh.
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('detectDevice', () => {
  it.each([
    ['an iPhone', { userAgent: IPHONE, maxTouchPoints: 5 }, 'phone'],
    ['an Android phone', { userAgent: ANDROID_PHONE, maxTouchPoints: 5 }, 'phone'],
    ['an Android tablet', { userAgent: ANDROID_TABLET, maxTouchPoints: 10 }, 'tablet'],
    ['an iPad in desktop mode', { userAgent: MAC, maxTouchPoints: 5 }, 'tablet'],
    ['a Mac', { userAgent: MAC, maxTouchPoints: 0 }, 'computer'],
    ['a Windows PC', { userAgent: WINDOWS, maxTouchPoints: 0 }, 'computer'],
    ['client hints saying mobile', { userAgent: WINDOWS, maxTouchPoints: 0, userAgentData: { mobile: true } }, 'phone'],
    ['client hints saying not mobile', { userAgent: ANDROID_PHONE, maxTouchPoints: 5, userAgentData: { mobile: false } }, 'computer'],
    ['client hints on an Android tablet', { userAgent: ANDROID_TABLET, maxTouchPoints: 10, userAgentData: { mobile: false } }, 'tablet'],
  ])('reads %s', (_, nav, kind) => {
    expect(detectDevice(nav)).toBe(kind);
  });

  it('has an icon and a label for every kind', () => {
    for (const kind of ['phone', 'tablet', 'computer', 'server'] as const) {
      expect(DEVICE_ICONS[kind].startsWith('<svg')).toBe(true);
      expect(deviceLabel(kind).length).toBeGreaterThan(0);
    }
  });
});
