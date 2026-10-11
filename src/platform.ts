// Where the page runs: a browser, or the iOS app. The iOS app (apple/capacitor.config.json) loads this
// same site and adds "tick3dApp/ios" to the user agent. The page marks <html data-platform>, so the CSS
// hides what the App Store does not allow ([data-hide-in~="ios"] in src/style.css) with no second build.
export type Platform = 'web' | 'ios';

export const platformOf = (userAgent: string): Platform => (/\btick3dApp\/ios\b/.test(userAgent) ? 'ios' : 'web');

export const platform = (): Platform => platformOf(navigator.userAgent);

export function markPlatform(): void {
  document.documentElement.dataset.platform = platform();
}
