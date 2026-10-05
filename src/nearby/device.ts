// The kind of device a player uses, so the Nearby screens can show a fitting icon.
export const DEVICE_KINDS = ['phone', 'tablet', 'computer'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

type NavigatorLike = Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { userAgentData?: { mobile?: boolean } };

// Uses User-Agent Client Hints where the browser has them (Chrome), else the user agent text.
// A guess that is wrong only changes an icon, so a best effort is enough here.
export function detectDevice(nav: NavigatorLike = navigator): DeviceKind {
  const agent = nav.userAgent;
  // An iPad asks for the desktop site and reports "Macintosh", but it has a touch screen.
  const isTablet =
    agent.includes('iPad') ||
    (agent.includes('Android') && !agent.includes('Mobile')) ||
    (agent.includes('Macintosh') && nav.maxTouchPoints > 1);
  if (nav.userAgentData?.mobile === true) return 'phone';
  if (isTablet) return 'tablet';
  if (nav.userAgentData?.mobile === false) return 'computer';
  if (agent.includes('iPhone') || (agent.includes('Android') && agent.includes('Mobile'))) return 'phone';
  return 'computer';
}

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// 'server' is a computer that runs the tick3d server for a local network.
export const DEVICE_ICONS: Record<DeviceKind | 'server', string> = {
  phone: svg('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'),
  tablet: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M11 17h2"/>'),
  computer: svg('<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>'),
  server: svg('<rect x="4" y="4" width="16" height="11" rx="1"/><path d="M2 19h20"/><path d="M8 8h2M8 11h5"/><circle cx="16" cy="9" r="1"/>'),
};

const LABELS: Record<DeviceKind | 'server', string> = {
  phone: 'Phone',
  tablet: 'Tablet',
  computer: 'Computer',
  server: 'Computer host',
};

export function deviceLabel(kind: DeviceKind | 'server'): string {
  return LABELS[kind];
}
