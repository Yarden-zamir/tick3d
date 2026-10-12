// The icons and the tier colors of the achievement badges. The page and the card image both draw them.
import type { Achievement, AchievementId } from './achievements.ts';

// The colors of each tier: a light top and a deep bottom. [data-tier] in src/style.css has the same colors.
export const TIER_COLORS: Record<Achievement['tier'], { light: string; deep: string }> = {
  bronze: { light: '#ffb36b', deep: '#c7672a' },
  silver: { light: '#eef3fb', deep: '#93a3bd' },
  gold: { light: '#ffe14d', deep: '#ff9d00' },
};

// The badge icons: the style of src/icons.ts (a 24 unit box, round strokes), drawn in black on the tier color.
const ROBOT = '<path d="M12 4.5V7M2.5 12v3M21.5 12v3"/><circle cx="12" cy="3.5" r="1"/><rect x="4.5" y="7" width="15" height="13" rx="3"/>';
const EYES = '<circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/>';
export const ACHIEVEMENT_ICONS: Record<AchievementId, string> = {
  'first-win': '<path d="M7 4h10v4a5 5 0 0 1-10 0V4ZM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 13v3M8 20h8l-1-4H9l-1 4Z"/>',
  'beat-easy': `${ROBOT}${EYES}<path d="M9 15.5a3.5 3.5 0 0 0 6 0"/>`,
  'beat-medium': `${ROBOT}${EYES}<path d="M7.5 9.5l3 1M16.5 9.5l-3 1M9 16.5h6"/>`,
  'beat-hard': `${ROBOT}<path d="M7.5 10.5l3 3M10.5 10.5l-3 3M13.5 10.5l3 3M16.5 10.5l-3 3M8.5 17.5l1.75-1 1.75 1 1.75-1 1.75 1M14.5 7l-1.5 2.5 2 1"/>`,
  'fastest-win': '<path d="M13.5 2 4.5 13.5H11L10 22l9.5-12H13L13.5 2Z" fill="currentColor"/>',
  'space-diagonal': '<rect x="3" y="9" width="12" height="12" rx="1"/><path d="M3 9l6-6h12v12l-6 6M15 9l6-6" stroke-width="1.8"/><path d="M3.5 20.5l17-17" stroke-width="3"/>',
  'board-hidden': '<path d="M2.5 9.5c2.5 4 5.5 5.5 9.5 5.5s7-1.5 9.5-5.5M6 13.5 4.5 16.5M12 15v3.5M18 13.5l1.5 3"/>',
  'coordinates-hidden': '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/>',
  'timed-win': '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M9.5 2.5h5M12 2.5V6M18.5 6.5 20 5"/>',
  'streak-3': '<path d="M2.5 18c3 2 16 2 19 0M6.5 18 7.5 4.5h9l1 13.5"/><path d="M7.1 13h9.8v2.5H6.9Z" fill="currentColor"/>',
  'streak-5':
    '<path d="M12 2.5c1 3.5 5.5 5.5 5.5 11a5.5 5.5 0 0 1-11 0c0-2.5 1.5-4 2.5-5 .5 2 1.5 3 2.5 3 0-3-1-6 .5-9Z"/><path d="M12 21a2.5 2.5 0 0 1-2.5-2.5c0-1.5 1.5-2.5 2.5-4 1 1.5 2.5 2.5 2.5 4A2.5 2.5 0 0 1 12 21Z" fill="currentColor"/>',
  'online-win': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z"/>',
  'nearby-win': '<circle cx="7.5" cy="8" r="3"/><circle cx="16.5" cy="8" r="3"/><path d="M2 20a5.5 5.5 0 0 1 11 0M11 20a5.5 5.5 0 0 1 11 0"/>',
  'full-cube': '<path d="M12 2.5 20.5 7 12 11.5 3.5 7Z" fill="currentColor"/><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7ZM12 11.5v10"/>',
  'games-10':
    '<path d="M8 2.5l2.5 6.5M16 2.5 13.5 9"/><circle cx="12" cy="15" r="6"/><path d="M12 12l.9 1.9 2.1.3-1.5 1.4.4 2.1-1.9-1-1.9 1 .4-2.1-1.5-1.4 2.1-.3Z" fill="currentColor" stroke-width="1"/>',
  'games-100':
    '<path d="M5 21v-7a7 7 0 0 1 14 0v7M9 21v-5.5h6V21"/><path d="M5.5 9.5C6 4.5 9 2.5 12 2.5s6 2 6.5 7c-2.5-2-10.5-2-13 0Z" fill="currentColor"/>',
};
export const LOCK_ICON = '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';

// The markup of an icon in currentColor: black in an image, the CSS color in the page. The card loads it as an image.
export const iconSvg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

