// The phone of a visitor of /testing: the Android path has Google Play codes, the iPhone path has TestFlight.
export const PHONES = ['android', 'iphone'] as const;
export type Phone = (typeof PHONES)[number];

export const isPhone = (value: unknown): value is Phone => PHONES.some((phone) => phone === value);

// The phone that the user agent names, or null for a computer and for an unknown device.
// Limit: an iPad on iPadOS 13 or later names a Mac, so it gets no preselection. The visitor picks by hand.
export function phoneOf(userAgent: string): Phone | null {
  if (userAgent.includes('iPhone') || userAgent.includes('iPad')) return 'iphone';
  if (userAgent.includes('Android')) return 'android';
  return null;
}
