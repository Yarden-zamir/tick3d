# App Store Connect answers

The `app-store-listing` workflow syncs the texts in `en-US/`, the screenshots, `app-store-connect.json` (category, content rights, age rating) and the price in `store/price-usd.txt`. This file explains those answers and holds the App Privacy answers, which you enter by hand.
Each answer follows the code: see `/privacy` and `server/store.ts`. Keep the answers consistent with [android/store/play-console.md](../../android/store/play-console.md).
Privacy policy: https://tick3d.yarden-zamir.com/privacy

## Synced from app-store-connect.json and store/price-usd.txt

- Category: Games, subcategory Board (`GAMES`, `GAMES_BOARD`), like Play.
- Content rights: the app uses no third-party content (`DOES_NOT_USE_THIRD_PARTY_CONTENT`).
- Price: the US dollar price in [store/price-usd.txt](../../store/price-usd.txt), the same file as Play (1.99 today). Apple sets the prices of the other countries from it. A paid price needs the Paid Applications agreement in App Store Connect first.
- Age rating: no violence, fear, sexual content, drugs, gambling, loot boxes, contests, ads or medical topics. Two answers are yes:
  - Messaging and chat: yes. Online games have a chat between players.
  - User-generated content: yes. Players set names and write chat messages that other players see. Reports, blocks and hidden messages moderate them.
- Unrestricted web access: no. The web view opens only the app's own domain.
- Play's IARC result is Everyone with "Users Interact". Apple computes its own rating from these answers. Check the result in App Store Connect after the first sync.

## App Privacy (manual)

The public App Store Connect API has no App Privacy endpoint (checked against the API specification 4.5.1 of 6 October 2026). fastlane sets it through the App Store Connect web session of an Apple ID, which CI does not have. Enter these answers in App Store Connect, App Privacy, and publish them. Update them here and there in the same change.

- Tracking: no. The app has no ads, no trackers and no data broker.
- Data collected: yes.

| Apple data type | What it is | Linked to the user | Purposes |
| --- | --- | --- | --- |
| Contact Info: Name | Custom player name (optional) | Yes | App Functionality |
| Identifiers: User ID | Random player token and its person id (a hash) | Yes | App Functionality |
| Identifiers: Device ID | App Store id of the device (`AppStore.deviceVerificationID`), for the purchase slots | Yes | App Functionality |
| Purchases: Purchase History | App Store purchase id (`appTransactionId`) of the bought app | Yes | App Functionality |
| User Content: Emails or Text Messages | Chat in online games, and a copy of a reported message | Yes | App Functionality |
| User Content: Gameplay Content | Moves, game results, Voice room runs | Yes | App Functionality |
| User Content: Other User Content | Reports (reason, note), blocks, the moderation log | Yes | App Functionality |
| Usage Data: Product Interaction | Device kind, theme, view, board or keypad | Yes | App Functionality, Analytics |
| Diagnostics: Other Diagnostic Data | Error message, file and line, and app version, without the player token | No | Analytics |

Where Apple differs from Play:

- Apple's App Functionality includes fraud prevention and security, so reports and blocks need no other purpose. Play lists "Fraud prevention, security and compliance" for them.
- Apple has no "Personal info: Other info" type. The GitHub id, login and picture address are not collected in the iPhone app, because it hides the GitHub login (App Store rule 4.8).
- The App Store purchase data has its own rows here (Purchase History, Device ID). Play's table has no row for the Play purchase check.
- The tester code form (email and name) is on the share page, which the iPhone app does not link to. Add Contact Info: Email Address if the app ever links to it.

Not collected:

- Audio Data: the microphone audio stays on the device (processed on device only).
- Location: the network address finds Nearby devices. It stays in memory only and is never stored.
- Photos or Videos: the QR scanner reads camera images on the device and does not save or upload them.
- Health, Financial Info, Contacts, Browsing History, Search History, Sensitive Info: none.
