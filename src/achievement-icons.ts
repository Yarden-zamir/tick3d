// The icons and the tier colors of the achievement badges. The page and the card image both draw them.
import type { Achievement, AchievementId } from './achievements.ts';

// The colors of each tier: a light top and a deep bottom. [data-tier] in src/style.css has the same colors.
export const TIER_COLORS: Record<Achievement['tier'], { light: string; deep: string }> = {
  stone: { light: '#d9d2c5', deep: '#8f8676' },
  bronze: { light: '#ffb36b', deep: '#c7672a' },
  silver: { light: '#eef3fb', deep: '#93a3bd' },
  gold: { light: '#ffe14d', deep: '#ff9d00' },
  // The page draws mythic as a moving rainbow foil. These two colors stand in for it in the card image.
  mythic: { light: '#e6b8ff', deep: '#6c5ce7' },
};

// The badge icons: the style of src/icons.ts (a 24 unit box, round strokes), drawn in black on the tier color.
const ROBOT = '<path d="M12 4.5V7M2.5 12v3M21.5 12v3"/><circle cx="12" cy="3.5" r="1"/><rect x="4.5" y="7" width="15" height="13" rx="3"/>';
const EYES = '<circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/>';
const CUBE = '<rect x="3" y="9" width="12" height="12" rx="1"/><path d="M3 9l6-6h12v12l-6 6M15 9l6-6" stroke-width="1.8"/>';
export const ACHIEVEMENT_ICONS: Record<AchievementId, string> = {
  'first-win': '<path d="M7 4h10v4a5 5 0 0 1-10 0V4ZM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 13v3M8 20h8l-1-4H9l-1 4Z"/>',
  'games-10': '<path d="M8 2.5l2.5 6.5M16 2.5 13.5 9"/><circle cx="12" cy="15" r="6"/><path d="M12 12l.9 1.9 2.1.3-1.5 1.4.4 2.1-1.9-1-1.9 1 .4-2.1-1.5-1.4 2.1-.3Z" fill="currentColor" stroke-width="1"/>',
  'games-100': '<path d="M5 21v-7a7 7 0 0 1 14 0v7M9 21v-5.5h6V21"/><path d="M5.5 9.5C6 4.5 9 2.5 12 2.5s6 2 6.5 7c-2.5-2-10.5-2-13 0Z" fill="currentColor"/>',
  'beat-easy': `${ROBOT}${EYES}<path d="M9 15.5a3.5 3.5 0 0 0 6 0"/>`,
  'beat-medium': `${ROBOT}${EYES}<path d="M7.5 9.5l3 1M16.5 9.5l-3 1M9 16.5h6"/>`,
  'beat-hard': `${ROBOT}<path d="M7.5 10.5l3 3M10.5 10.5l-3 3M13.5 10.5l3 3M16.5 10.5l-3 3M8.5 17.5l1.75-1 1.75 1 1.75-1 1.75 1M14.5 7l-1.5 2.5 2 1"/>`,
  'fastest-easy': '<path d="M13.5 2 4.5 13.5H11L10 22l9.5-12H13L13.5 2Z"/>',
  'fastest-medium': '<path d="M13.5 2 4.5 13.5H11L10 22l9.5-12H13L13.5 2Z" fill="currentColor"/>',
  'fastest-person': '<path d="M12 1.8l2.4 4.4 4.9-1-1.6 4.7 3.8 3.3-4.9 1.2-.3 5L12 16.6l-4.3 2.8-.3-5-4.9-1.2 3.8-3.3-1.6-4.7 4.9 1Z"/><path d="M9.6 8.6h4.8l-2.6 5.6" stroke-width="2.4"/>',
  'space-diagonal-easy': `${CUBE}<path d="M3.5 20.5l17-17" stroke-dasharray="1.5 3"/>`,
  'space-diagonal-medium': `${CUBE}<path d="M3.5 20.5l17-17" stroke-width="3"/>`,
  'space-diagonal-hard': `${CUBE}<path d="M3.5 20.5l17-17" stroke-width="3"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/><path d="M12 5.5v1.5M18.5 12H17M7 12H5.5M12 18.5V17"/>`,
  'space-diagonal-person': `<g transform="translate(6 0) scale(0.75)">${CUBE}<path d="M3.5 20.5l17-17" stroke-width="3"/></g><circle cx="4.5" cy="16" r="2"/><path d="M1.2 22.5a3.3 3.3 0 0 1 6.6 0"/>`,
  'board-hidden-person':
    '<path d="M2.5 7.5c2.5 4 5.5 5.5 9.5 5.5s7-1.5 9.5-5.5M6 11.5 4.5 14.5M18 11.5l1.5 3"/><path d="M12 22s-4.5-2.6-4.5-5.4a2.3 2.3 0 0 1 4.5-.8 2.3 2.3 0 0 1 4.5.8C16.5 19.4 12 22 12 22Z" fill="currentColor"/>',
  'board-hidden-easy': '<path d="M2.5 12c2.5-2 6-2 8 0M13.5 12c2-2 5.5-2 8 0"/><path d="M3 15.5c2 1 5.5 1 7.5-.5M13.5 15c2 1.5 5.5 1.5 7.5.5"/><path d="M4 7l4 1.5M20 7l-4 1.5"/>',
  'board-hidden-medium': '<path d="M2.5 9.5c2.5 4 5.5 5.5 9.5 5.5s7-1.5 9.5-5.5M6 13.5 4.5 16.5M12 15v3.5M18 13.5l1.5 3"/>',
  'board-hidden-hard': '<path d="M12 9.5 10.8 7l-.6 2.6C7.5 9.8 4.5 8.6 1.8 6.5c.4 3 1.6 5.2 3.6 6.3 1.1-1 2.7-1 3.8.1.8-.9 1.8-1.4 2.8-1.4s2 .5 2.8 1.4c1.1-1.1 2.7-1.1 3.8-.1 2-1.1 3.2-3.3 3.6-6.3-2.7 2.1-5.7 3.3-8.4 3.1L13.2 7Z" fill="currentColor"/><path d="M8.5 16.5c2.2 1.3 4.8 1.3 7 0M6 19.5c3.6 2 8.4 2 12 0"/>',
  'computer-streak-easy-5': `${ROBOT}<path d="M7.5 12.5c.7.8 2.3.8 3 0M13.5 12.5c.7.8 2.3.8 3 0M10.5 16.5h3"/><path d="M15.5 1.5h3.5l-3.5 3.5h3.5" stroke-width="1.6"/>`,
  'computer-streak-medium-3': '<path d="M14.8 3.2a5 5 0 0 0-4.9 6.9l-6.4 6.4a2 2 0 0 0 2.9 2.9l6.4-6.4a5 5 0 0 0 6.9-4.9l-3 3-2.9-.5-.5-2.9Z"/>',
  'computer-streak-medium-5': '<path d="M8.5 14.5V5a2.5 2.5 0 0 1 5 0v9.5a4.5 4.5 0 1 1-5 0Z"/><circle cx="11" cy="18" r="2" fill="currentColor"/><path d="M11 16V9"/><path d="M17 3.5c1.2 1-1.2 2.2 0 3.4s-1.2 2.2 0 3.4M20.5 5.5c1.2 1-1.2 2.2 0 3.4" stroke-width="1.8"/>',
  'computer-streak-medium-10': '<path d="M19.5 12A7.5 7.5 0 1 1 17.3 6.7"/><path d="M18 2.5v4.5h-4.5"/><path d="M12 8.5v4.5"/><circle cx="12" cy="16.5" r="0.4" fill="currentColor"/>',
  'computer-streak-hard-2': '<path d="M2.5 12H7l1.8-4 2.4 8 2.4-8 1.8 4h4.1"/><path d="M12 2.5v2.5M6.5 4.5l1.3 1.8M17.5 4.5l-1.3 1.8M12 19v2.5M6.5 19.5l1.3-1.8M17.5 19.5l-1.3-1.8"/>',
  'computer-streak-hard-5': '<circle cx="12" cy="12" r="2.6" fill="currentColor"/><path d="M12 3.5A8.5 8.5 0 0 1 20.5 12a6 6 0 0 1-6 6 3.8 3.8 0 0 1-3.8-3.8M12 20.5A8.5 8.5 0 0 1 3.5 12a6 6 0 0 1 6-6 3.8 3.8 0 0 1 3.8 3.8"/>',
  'streak-3': '<path d="M2.5 18c3 2 16 2 19 0M6.5 18 7.5 4.5h9l1 13.5"/><path d="M7.1 13h9.8v2.5H6.9Z" fill="currentColor"/>',
  'streak-5': '<path d="M12 2.5c1 3.5 5.5 5.5 5.5 11a5.5 5.5 0 0 1-11 0c0-2.5 1.5-4 2.5-5 .5 2 1.5 3 2.5 3 0-3-1-6 .5-9Z"/><path d="M12 21a2.5 2.5 0 0 1-2.5-2.5c0-1.5 1.5-2.5 2.5-4 1 1.5 2.5 2.5 2.5 4A2.5 2.5 0 0 1 12 21Z" fill="currentColor"/>',
  'timed-win': '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M9.5 2.5h5M12 2.5V6M18.5 6.5 20 5"/>',
  'timed-win-short': '<circle cx="10" cy="14.5" r="6.5"/><path d="M14.5 9.5l2-2"/><path d="M16.5 7.5c.8-1.6 2.3-2.3 3.8-1.8"/><path d="M20.5 1.8v2M22.2 3.5h-2M21.7 2.2l-1.2 1.2" stroke-width="1.6"/><path d="M6.8 12.8a3.5 3.5 0 0 1 2.5-2.3"/>',
  'timed-win-bullet': '<circle cx="14.5" cy="13.5" r="7"/><path d="M14.5 13.5l2.8-3.2M12.5 3h4M14.5 3v3.5"/><path d="M1.5 10h3.5M1 13.5h3M1.5 17h3.5"/>',
  'won-on-time': '<path d="M5.5 21.5V3"/><path d="M5.5 3.5c3-1.5 5 1.5 8 0s4-.5 5 0v8c-1-.5-2-1.5-5 0s-5-1.5-8 0"/><path d="M19.5 15v6.5M17.3 19.3l2.2 2.2 2.2-2.2"/>',
  'o-win-medium': '<circle cx="8.5" cy="12" r="5.5"/><path d="M15.5 8.5h3.5a2 2 0 1 0-2-2M15.5 12h6M15.5 15.5h3a2 2 0 1 1-2 2"/>',
  'o-win-hard': '<circle cx="12" cy="15" r="6"/><path d="M6.5 8 7.8 3l4.2 2.8L16.2 3l1.3 5Z" fill="currentColor"/>',
  'o-win-person': '<circle cx="12" cy="12" r="5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
  'online-win': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z"/>',
  'nearby-win': '<circle cx="7.5" cy="8" r="3"/><circle cx="16.5" cy="8" r="3"/><path d="M2 20a5.5 5.5 0 0 1 11 0M11 20a5.5 5.5 0 0 1 11 0"/>',
  'people-5': '<path d="M12 7.5V19"/><path d="M12 10.5C10 5.5 3 3 3 7.8c0 3 3 4.4 9 4.4s9-1.4 9-4.4C21 3 14 5.5 12 10.5Z"/><path d="M12 13c-2 0-6 1-6 3.8s4 2.6 6-1c2 3.6 6 3.8 6 1S14 13 12 13Z"/><path d="M12 7.5 10 4M12 7.5l2-3.5"/>',
  'people-20': '<circle cx="12" cy="7" r="3"/><circle cx="4.8" cy="10" r="2.2"/><circle cx="19.2" cy="10" r="2.2"/><path d="M6.5 20a5.5 5.5 0 0 1 11 0M1.5 18a3.6 3.6 0 0 1 4.8-3.4M22.5 18a3.6 3.6 0 0 0-4.8-3.4"/>',
  'friend-game': '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/><path d="M2.5 9.5 5 12l-2.5 2.5M21.5 9.5 19 12l2.5 2.5"/>',
  'friend-streak-5': '<path d="M14.5 3a8 8 0 1 0 6.5 11.5A6.5 6.5 0 0 1 14.5 3Z"/><path d="M5 3.5v3M3.5 5h3M8.5 1.5v1.5" stroke-width="1.8"/>',
  'coordinates-hidden': '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/>',
  'elevator': '<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M12 6.5v11M9.3 9.2 12 6.5l2.7 2.7M9.3 14.8 12 17.5l2.7-2.7"/>',
  'fork': '<path d="M7.5 2.5v6a4.5 4.5 0 0 0 9 0v-6M12 2.5v6M12 13v8.5"/>',
  'full-cube': '<path d="M12 2.5 20.5 7 12 11.5 3.5 7Z" fill="currentColor"/><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7ZM12 11.5v10"/>',
  'sound-only':
    '<path d="M9 4.5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0Z"/><path d="M5.5 10a6.5 6.5 0 0 0 13 0M12 16.5V20M8.5 21h7"/><path d="M2.5 6.5c-1 2-1 5 0 7M21.5 6.5c1 2 1 5 0 7" stroke-width="1.8"/>',
  'nemesis': '<circle cx="12" cy="13.5" r="7.5"/><path d="M5.8 9.2 3.5 3l5 3.5M18.2 9.2 20.5 3l-5 3.5"/><path d="M7.8 12l3 1.2M16.2 12l-3 1.2M9 17.5c2-1.3 4-1.3 6 0"/>',
  'revenge': '<path d="M19.5 8H8.5a4.5 4.5 0 0 0 0 9H17"/><path d="M15.5 4.5 19.5 8l-4 3.5"/><path d="M14 17l3 0" />',
  'lost-to-easy': `${ROBOT}${EYES}<path d="M9 15.5h6M11 15.5v2.2a1 1 0 0 0 2 0v-2.2"/>`,
  'photo-finish': '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 4h6v5.3H3ZM15 4h6v5.3h-6ZM9 9.3h6v5.4H9ZM3 14.7h6V20H3ZM15 14.7h6V20h-6Z" fill="currentColor"/>',
  'last-move': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7.5 3v18M12 3v18M16.5 3v18M3 7.5h18M3 12h18M3 16.5h18" stroke-width="1.3"/><rect x="16.5" y="16.5" width="4.5" height="4.5" fill="currentColor"/>',
  'invite-1': '<circle cx="9" cy="7.5" r="3.5"/><path d="M2.5 20.5a6.5 6.5 0 0 1 13 0"/><path d="M19 8v6M16 11h6"/>',
  'invite-5': '<path d="M3 10v4h3l9 5V5L6 10Z"/><path d="M6 14l1.5 6h3L9 15.5"/><path d="M18.5 9a4 4 0 0 1 0 6M20.5 6.5a7.5 7.5 0 0 1 0 11" stroke-width="1.8"/>',
  'invite-25':
    '<rect x="1" y="10.5" width="15" height="3.5" rx="1.75" transform="rotate(-40 8.5 12.25)"/><circle cx="6.2" cy="14.2" r="0.7" fill="currentColor"/><circle cx="8.5" cy="12.25" r="0.7" fill="currentColor"/><circle cx="10.8" cy="10.3" r="0.7" fill="currentColor"/><path d="M16.5 8.5V3l4.5-1v5.5"/><circle cx="15.2" cy="8.7" r="1.5" fill="currentColor"/><circle cx="19.7" cy="7.7" r="1.5" fill="currentColor"/>',
};
// A hidden achievement before its unlock.
export const HIDDEN_ICON = '<path d="M8.5 9a3.5 3.5 0 1 1 5 3.2c-1 .5-1.5 1.2-1.5 2.3v.5"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>';
export const LOCK_ICON = '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';

// The markup of an icon in currentColor: black in an image, the CSS color in the page. The card loads it as an image.
export const iconSvg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

