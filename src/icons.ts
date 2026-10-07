// The inline icons that the scripts draw. They use the text color, so they follow the theme. Emoji do not.
// The icons in the HTML pages use the same style: a 24 unit box, round strokes 2.2 to 2.5 wide.

const icon = (body: string, strokeWidth = 2.4) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const SPEAKER = '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>';
export const SOUND_ON_ICON = icon(`${SPEAKER}<path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>`, 2.5);
export const SOUND_OFF_ICON = icon(`${SPEAKER}<path d="M16 9.5l5 5M21 9.5l-5 5"/>`, 2.5);

// The lock body with a keyhole. The closed shackle goes into the body on both sides. The open one lifts on the right.
const LOCK_BODY = '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M12 14.5v2"/>';
export const LOCK_CLOSED_ICON = icon(`${LOCK_BODY}<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>`);
export const LOCK_OPEN_ICON = icon(`${LOCK_BODY}<path d="M8 10.5V6.5a4 4 0 0 1 7.8-1.3"/>`);

export const PLAY_ICON = icon('<path d="M8 5.5v13l10.5-6.5Z" fill="currentColor"/>', 2.2);

// An eye: a watcher in the Players box.
export const EYE_ICON = icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>');

// A bar chart: the Stats button of My games.
export const STATS_ICON = icon('<path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/>');
