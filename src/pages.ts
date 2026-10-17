// The HTML pages of the site. The build (vite.config.ts) makes one entry per page.
// The Caddyfiles and the Dockerfile take every root *.html file, so they need no list.
// src/markup.test.ts checks that this table and the root *.html files agree.
export const PAGES = {
  main: { file: 'index.html', path: '/' },
  stats: { file: 'stats.html', path: '/stats' },
  training: { file: 'sound-training.html', path: '/sound-training' },
  input: { file: 'sound-input.html', path: '/sound-input' },
  // The privacy policy. The Play listing of the Android app links here, so keep the address.
  privacy: { file: 'privacy.html', path: '/privacy' },
  // The Android and iPhone closed test: the steps to join, and the Google Play promo codes. testing.tick3d.yarden-zamir.com redirects here (Caddyfile.j2).
  testing: { file: 'testing.html', path: '/testing' },
} as const satisfies Record<string, { file: `${string}.html`; path: `/${string}` }>;

export type PageName = keyof typeof PAGES;
