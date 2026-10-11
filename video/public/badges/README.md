# Store badges

The official badge artwork of Apple and Google. They are trademarks of their owners, not part of the MIT license of this repository.

- `app-store.svg`: "Download on the App Store", black, US English. Source: https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg. Rules: https://developer.apple.com/app-store/marketing/guidelines/
- `google-play.png`: "Get it on Google Play", US English. Source: https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png. Rules: https://play.google.com/intl/en_us/badges/

Use the files as provided: do not edit, tilt or animate them. `src/hud.ts` draws them with clear space of a quarter of the badge height, the App Store badge first, and the credit line of each company.

Apple licenses its badge only for apps on the App Store, and only to members of the Apple Developer Program. tick3d has no App Store app yet, so the end card shows "soon" next to the badge (maintainer decision on #119).
