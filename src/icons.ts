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

// The same microphone as the "Sing to the board" link in index.html.
export const MIC_ICON = icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', 2.2);

export const PLAY_ICON = icon('<path d="M8 5.5v13l10.5-6.5Z" fill="currentColor"/>', 2.2);
export const PAUSE_ICON = icon('<path d="M8.5 5.5v13M15.5 5.5v13"/>', 3);

// An eye: a watcher in the Players box.
export const EYE_ICON = icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>');

// Watcher chat: a speech bubble, the same as the chat notice in index.html. Off adds a slash.
const BUBBLE = '<path d="M5 4.5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z"/>';
export const CHAT_ON_ICON = icon(`${BUBBLE}<path d="M8 9.5h8M8 13h5"/>`);
export const CHAT_OFF_ICON = icon(`${BUBBLE}<path d="M3 3l18 18"/>`);

// A bar chart: the Stats button of My games.
export const STATS_ICON = icon('<path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/>');
// Report: a flag. Block: a circle with a slash.
export const FLAG_ICON = icon('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>');
export const BLOCK_ICON = icon('<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>');

// The GitHub mark, filled, as in the footer of every page (index.html).
export const GITHUB_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

// The Google "G" mark in its four colors, as the Sign in with Google branding asks
// (https://developers.google.com/identity/branding-guidelines).
export const GOOGLE_ICON = `<svg viewBox="0 0 48 48" width="16" height="16" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
