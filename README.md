# tick3d

[![kitshn](https://kitshn.yarden-zamir.com/b/Yarden-zamir/tick3d.svg)](https://tick3d.yarden-zamir.com)

3D tic-tac-toe on a 4×4×4 cube, at [tick3d.yarden-zamir.com](https://tick3d.yarden-zamir.com).

![A game against the computer in the tower view](docs/screenshots/tower.png)

## Rules

- Two players take turns. X moves first.
- Four marks in a straight line win. There are 76 lines: 48 along an axis, 24 diagonals inside a plane, and 4 through the cube.
- A full cube with no line is a draw.

## Features

- Play against the computer, a friend on the same device, a friend online, or devices on the same Wi-Fi with Nearby.
- The computer has three levels. Each level plays a different game each time: the first move goes to a random strong cell, and later choices are weighted by how good a cell is, not fixed. A strong cell is one of the 8 corners or the 8 inner cells, which each sit on 7 lines.
  - Easy: takes a win when it sees one. It blocks your win a bit more than half the time early in a game, and cares more about its own lines than yours, so it leaves openings.
  - Medium: takes a win and always blocks your win early in a game. Sometimes it makes a double threat (two winning cells at once), or takes the cell where you could make one. Otherwise it picks one of its best cells by weight.
  - Hard: takes a win and blocks your win. It looks for a win by threats in a row, and avoids a move that gives you one. Otherwise it searches ahead with alpha-beta pruning for up to 600 ms (at most 1000 ms in the advanced settings) and picks among the moves that score about the same as the best.
  - Easy and medium tire in a long game, like a person under more and more load. From a set move on, they block less often, see fewer double threats, and choose more randomly. A missed block means that the computer did not see your threat at all. Medium starts to tire at move 20 and is fully tired at move 60, when it blocks 85% of the time. Hard does not tire.
- Advanced settings: in computer mode, "Advanced: computer player" at the bottom of the panel lists every number behind the computer, for each level. Easy and medium have a fresh and a tired value for each chance and for the randomness, and the moves where tiring starts and ends. Hard has its thinking time, search width, threat depth and equal-move margin. A change applies from the next computer move, and "Reset to defaults" restores the tested values. A lock also locks these settings. A game counts as tuned when the settings of its own level, or the setting for all levels, differ from the defaults: a changed hard level does not make an easy game tuned. A tuned game keeps its own survival records, and its end card says "(tuned)".
- Move validation: an occupied cell, a move after the game ends, a move out of turn, or a move by a spectator is refused with a sound and a message. A tap on an occupied cell then also plays the sound of the mark on it. Every mode runs the same session rules (`src/session/core.ts`): the server for online games, the device for computer and friend games, the host's device for Nearby games.
- Hide the board, or hide all marks except the last move. Play by coordinates: tap the layer, row and column on the 1 to 4 keypad, for example `2 3 4`. The target cell is outlined before you place. Until you tap a number, the keypad shows the coordinates of the last move, yours or the other player's, so you can follow the game with the board hidden. Hidden marks show again when the game ends.
- Lock settings: the small Lock button sits in the Hide row of the panel. After a lock, no setting (the view included) changes until the game ends: the opponent, level, side, view, layout, time limit, hide options and the advanced computer settings. New game, Undo, the join box and the switch to another session in My games also wait. Home still leaves the game, after the usual question. The session keeps the lock, so a reload does not end it. With another device, either player can lock, and the lock holds for both players. A lock waits until both seats have a player, because a game without a second player cannot end. Watchers cannot lock, and a lock does not hold the settings of a watcher. The theme, the sound, the sound set and the angle of the tower stay free. Leave and End of a Nearby game also stay open.
- Session history: My games lists the games of the open session, with the result of each. Replay closes the dialog and steps through a game on the board, move by move. Card opens the result card of a finished game. A session holds any number of games.
- Time limits, like a chess clock: a limit per player for the whole game (30 s to 120 min), a limit per move (3 s to 10 min), or both. Each limit has a switch, a number box and quick picks. A player who runs out of either limit loses. The first move of each player is untimed, so the clock starts after both players moved once. A clock ticks in the last 10 seconds. A timed game has no undo.
- A game keeps the time limit it started with. A change during a game starts with the next game, and the panel shows both limits until then.
- End card: at the end of a game, a card shows the result, the final board and the game details, the hide settings included. New game on the card starts the next game. The card uses the active theme. Share sends the image through the system share sheet. Without file sharing (most desktop browsers), Share copies the image, and Save image downloads it. Two check boxes, both on by default, add the game code and the link of the game (see Game links) to the card and the share text. A local game has no code, so it shows only the link option.
- Survival records: when the computer wins, the number of moves that the game lasted can be a new record. Each level, time limit and hide setting keeps its own record. A new record shows as a message and as a sticker on the end card, with the old best. The first loss of a setup sets the record without a message. The device keeps its records for offline play, and the server keeps the records of every game it received. On each visit the page takes the higher record of each setup from the server, so a new record must beat the best of every device of the account.
- Sound effects made with Web Audio. The sound control in the actions row has two parts: the speaker turns the sound on and off, and the narrow arrow next to it opens the sound set menu. The menu groups the sets by character: Instruments, World and voice, Playful, For musicians and Original. Each set has a play button for a demo. The choice belongs to the screen, like the theme, and the default is Cells. In every set except Classic, each cell has its own single sound, so a game works by ear. X and O always sound different.
  - Cells: the pitch is the layer (C, D, E, G of a pentatonic scale, higher layers higher), the instrument is the row (marimba, glass bell, plucked string, whistle), and the width is the column (one voice, then a fifth, an octave, both; on headphones also left to right). O sounds one octave below X.
  - Soft, Orchestra, Lo-fi keys: the Cells map with other instruments. Soft has flute, clarinet, felt piano, vibraphone. Orchestra has pizzicato strings, harp, French horn, celesta. Lo-fi keys has electric piano, pad pluck, upright bass, music box.
  - Gamelan: the layer is a slendro note, the row is the bronze instrument (saron, bonang, gender, gong), the column is the beat of the tuned pair (none, slow, fast, shimmer). O plays an octave lower.
  - Chiptune: the layer is the note, the row is the move of the first note (blip, jump, drop, warble), the column is the arpeggio length (1 to 4 notes). X is a square wave, O a triangle wave an octave lower.
  - Kalimba: the layer is the note, the row is the tine (warm, steel, buzz, wah), the column is the count of box echoes (0 to 3). O plays an octave lower.
  - Percussion: no melody. The layer is the drum (kick, tom, snare, woodblock), the row is the tuning, the column is the stroke (single, flam, double, drag). X plays with sticks, O with soft mallets.
  - Choir: the layer is the sung note, the row is the vowel (ah, eh, ee, oh), the column is the harmony (solo, third, fifth, full chord). X is a tenor, O a bass.
  - Nature: the layer is the source (wood knock, water drop, cricket, bird), the row is its size, the column is the weather (calm, breeze, rain, cave echo). O is the night, an octave lower.
  - Harmony: for musicians. Equal temperament, A4 = 440 Hz, chords of C major. The layer is the octave of the root (3 to 6), the row is the chord (I, IV, V, vi), the column is the voicing (root position, 1st inversion, 2nd inversion, seventh chord: Cmaj7, Fmaj7, G7, Am7). X plays a piano, O an organ.
  - Classic: the first sound of the game. Each layer has one note, so it does not name the row or the column.

  The keypad plays the cell's sound when its third number is in, and the speaker button by the keypad plays the last move again. A mute button keeps the choice. `/sound-training` (the "Train your ear" button at the bottom of the panel) is an ear trainer like Anki. It trains the chosen sound set, and Cells when the choice is Classic. The note button in its header opens the same sound set menu as the game, and a choice there changes the set of the game too. It shows each sound with its answer first, then asks for it with the answer hidden, and gives more cards for the part that the player misses most. The player answers on the four layers of the board: a tap selects the whole layer, row or column that the card asks for, or one cell. The board size and layout fit the screen, and on a phone the layers scroll sideways. After a check, the exact tapped cell keeps an outline, also when the asked part is right. It keeps its progress in the browser and works offline. Search engines may list it.
- `/sound-input` is a toy: turn on the microphone, then whistle, hum or sing, and the board lights the cell of your pitch, live. The range runs from low to high in 64 equal musical steps, one for each cell. The four rows split it, the highest row on top, and inside a row a slide up sweeps layer 1, column 1 to layer 4, column 4. The default range is 150 to 2400 Hz, one octave for each row: hum for rows 4 and 3, whistle for rows 2 and 1. "Calibrate to your voice" asks for your lowest and then your highest comfortable sound, 2 seconds of clear pitch each, and moves the edges of the range to the median of each. A range must span half an octave; a range under one octave shows a hint. A sound outside the range lights the nearest edge. A pitch rail shows the range with its rows, layers and columns, a cursor at your pitch, and the sticky band. Stickiness keeps a held cell lit when the pitch wobbles: the margin past the cell border starts at zero and grows to the chosen stickiness over the build-up time. The browser keeps the range and the stickiness. On a phone the board shows all four layers in a 2 × 2 grid while you sing. Hold a note for 1 second to place an X. A tap on a cell plays it in the sound set of the game. The "Sing to the board" link in the game panel opens the page. The page detects the pitch in the browser and sends no sound anywhere. It works offline.
- Drag sideways anywhere around the tower to turn it all the way round. A drag that starts on the keypad or on another control does not turn the tower. The tilt stays at the resting view. On a touch screen, a vertical swipe still scrolls the page. Reset angle, next to the View picker, returns to the resting view, and the browser keeps the angle. A drag never places a mark. Boards and tiles have real 3D depth in the tower, so they look solid at any turn. Layer 1 is the bottom plane and layer 4 the top one; the flat view labels each layer.
- The status of the game (whose move, the result) sits in the header row. Below 64rem it takes its own line under the header row, and a long status wraps. The other pages show their name in that place.
- Two views: a 3D tower of tilted layers and a flat view. The flat view has four layouts: grid, side by side, top to bottom, and steps.
- Twelve neo-brutalist themes in a folding menu in the panel: Light (the default), Dark, Snow, Candy, Mint, Retro, Midnight, Synthwave, Bloodmoon, Dark coffee, Batman (dark, no color) and Mono. Like the mute button, the theme stays open during a lock.
- Point at a cell to light up the cells above and below it.
- Every page (the game, `/stats`, `/sound-training` and `/sound-input`) has the same header (`src/header/`): the wordmark links home, then My games, Info, kitshn and GitHub. It works offline. Only the kitshn list needs a network.
- My games opens the My games dialog on the game page. On another page it links to `/?open=my-games`, and the game page opens the dialog. A GitHub login from there returns to the page that the player came from. The button shows the login on every page.
- Info opens a panel with the text of the page: on the game page the rules and how to play (keypad and hide options, sounds, time limits, the lock, online and Nearby play), what the numbers mean on `/stats`, and how the trainer works on `/sound-training`. Close, Escape or a tap outside the panel closes it.
- A GitHub button in the header links to this repository.
- A kitshn button in the header lists the open pull requests that have a live preview: the title, the first paragraph of the text, the contributors, and links to the preview and to the pull request. A preview page marks its own entry with "You are here".
- Tooltips: the lock and the icon buttons (sound, sound set, Reset angle, the header buttons) show a short text on hover, on keyboard focus, and on a long press on a touch screen (`src/tooltip.ts`). A long press does not press the button. A short tap works as usual.
- Buttons share one component in `src/style.css`: `.btn`, with `.btn-primary`, `.btn-small` and `.btn-icon`.
- The browser keeps the settings in `localStorage`. The app checks each stored value and uses the default for a value that is not valid.

![The flat view in the grid layout, Midnight theme](docs/screenshots/flat.png)

![Synthwave, Candy and Mono themes on a phone](docs/screenshots/themes.png)

<img src="docs/screenshots/end-card.png" alt="The end card of a won game" width="360">

## Game links and match history

- Every finished game gets an id and a read-only link. An online game uses its session code and game number (`/?game=AB3K-2`). Any other game gets 8 random characters from the device that played it (`/?game=K7P2QX9M`). The server keeps each id unique and gives a new id when two devices pick the same one.
- At the end of a game the address shows the link, and the end card shares it. A new game, a switch to another game or Home removes it from the address. An online game keeps its `?code` too.
- The link shows the final board with the replay controls, the players (the GitHub name of a player with a login, else the generated name), the mode, the level, the time limit, the hide settings, the date and the result. Nobody can move in it, and it has no next game. Play goes back to a game of your own.
- A game that this device did not upload yet opens from the device copy, also offline.
- My games has a History list of every finished game in every mode, newest first, 50 at a time, with a View button. Offline, it lists the games on this device.
- Clear history in My games asks first, then removes every finished game from the player's history: on the server for every device of the account (or for this browser without a login), and from the uploaded results on this device. The survival records and the totals stay. An online game stays in the opponent's history, and every game still counts in the site stats.
- A game stored before game links shows in the history without a View button, until a one-off migration gives it an id.

## Online play

- Choose Online to create a session. The page shows a 4 character code and puts it in the link (`?code=AB3K`). Link sends the link, or copies it when the device cannot share. QR code shows the link as a QR code, which a phone camera opens directly.
- Codes use letters and digits without `0`, `O`, `1` and `I`, so a code read aloud is not ambiguous.
- The creator plays X. The first other browser that opens the code plays O. Further browsers watch.
- A browser keeps its seat through a random token in `localStorage`.
- A link with a code that opens no game (no game with that code, or no network for a new game) shows the error, drops the code from the address, and starts the page as usual.
- A code loads the full session, finished games included. Either player can name the session and start the next game after a game ends.
- Chat: on a wide screen a column at the left, on a narrower one a box under the board. It sends messages to the other player in real time, online and over Nearby. Only the two players can write, watchers read along. A session keeps its newest 50 messages of up to 200 characters.
- Hide coordinates keeps the coordinates of the last move off the keypad: the slots show "?", and the speaker button still plays the move, so the game goes by ear. Turning it on highlights the "Train your ear" button.
- Hide board, Hide history and Hide coordinates belong to the session. A change by either player applies to both players and to watchers. View and layout stay per screen.
- The time limit also belongs to the session. A new session takes the time limit of the screen that creates it. Either player can change it at any time, except during a lock. The change reaches both players and starts with the next game. The server records the move times and decides a timeout, so a page that closes cannot avoid a loss on time.
- A session with moves never expires, so the same two players can keep playing for as long as they like. A session where no game has a move goes away after 9 hours without a change, unless a player has it open. After the first join, a player can leave and come back later: the game waits for their move. The other player sees them as away (a dimmed score tile and "is away" in the status), so a game can also run asynchronously. A clock keeps running while a player is away.
- There is no limit on played sessions or on games per session. Add one when storage use calls for it.

![An online game with chat, while the other player is away](docs/screenshots/online.png)

## Play with an AI agent

- An AI agent can play through the tick3d HTTP API, with plain HTTP or curl. It needs no account and no key.
- In computer mode, open "Advanced: computer player". The "Play with your AI agent" part has a short text and a Copy button. Give the text to your agent.
- The text points the agent to the OpenAPI document at `/api/openapi.json`, and tells it to wait for your instructions. The agent starts no game on its own. The document tells the agent how to create or join a game, take a seat from a link, move, chat and wait for changes.
- The agent can play you or another agent. In a game between two agents, the agent gives you the game link, and you watch.
- A browser that opens the link while a seat is free takes that seat. So an agent gives the link for watching after both seats are taken.
- A player that uses the API has no open page, so the page shows that player as away. The game goes on as usual.

The docs of the tick3d HTTP API come from one file, `server/api-docs.ts`:

- `GET /api/openapi.json`: the OpenAPI 3.1 document. `info.description` holds the guide: the quick start, the player id, the cell numbers, waiting, refused moves, game links and limits. Each operation has a description and a curl example.
- `GET /api/docs`: the document in Swagger UI, with "Try it out". The page loads Swagger UI from jsDelivr, pinned to one version with integrity hashes.
- `GET /api/sessions/<code>?wait=<version>`: a long poll. The server holds the request until the session version is greater than `<version>`, or for about 25 s. Then it returns the session. At most 2000 requests wait at the same time.
- Every session answer has `turn` (the player to move, or null after the game ends) and `status` (playing, won with the line, timeout or draw), so an agent needs no rules of its own.

## Offline play

- After the first visit, the game opens without a network: a service worker keeps the page, the fonts and the icons. The game is installable on a phone.
- Computer and friend games run on the device and are stored in its IndexedDB. Every played session stays on the device, with no limit. A session with no move goes away 9 hours after its last change, when the game next starts. A reload or a restart continues the game.
- An online game this device saw before opens read-only without a network, as last seen.
- When a computer, friend or Nearby game ends and the network is up, the device sends the result to the server. Results from games played offline go along with it. A result has an id from the device, so the server stores it once.
- After a deploy, a returning player sees "A new version of tick3d is ready" with a Reload button. The page never reloads by itself in the middle of a game.
- Safari deletes the stored data of a site that the player does not open for 7 days. A game added to the home screen keeps its data.

## Nearby

- Choose Nearby to play with devices on the same Wi-Fi. One device hosts, the others join.
- Games near you: while a device is online, its hosted game shows up in a list on the other devices of the same network. The list updates every 3 seconds. Each game shows the device icon, the name and a Join button, and one tap joins it. The host's panel says "Visible to devices on this network". The list never shows the game of this device.
- A web page cannot broadcast or discover on a local network: browsers have no UDP and no mDNS API. So the host announces its game through the server, and the list works only while both devices are online. The server lists a game only for requests from the same network: the same IPv4 address, or the same IPv6 /64 prefix. A home where one device uses IPv4 and another IPv6 is two networks for the server, so the two devices do not see each other in the list.
- A game leaves the list within seconds when the host ends it, closes the page, goes offline or switches mode. A host that loses the network without a word leaves the list after 35 seconds at most.
- Without internet, the list is off, and the codes below connect the devices.
- Join with a code: the host shows a QR code. The guest scans it with the phone's own camera, which opens the game, and shows its own code, which the host scans the same way. On the host, the answer opens in a new tab that hands the code to the hosting tab. Each code also has a text form to copy and paste, for a device without a camera.
- The devices then talk directly over WebRTC. The host's device holds the session and checks every move with the same rules as the server, so a guest can never move for the host.
- The panel lists the connected devices with an icon for each kind: phone, tablet or computer. The device name starts as the player's name, and the player can change it. The first guest plays O, later guests watch.
- The host's screen stays on while it hosts. When the host ends the game or closes the page, the guests see a message.
- Chat, the lock, the hide options and time limits work as in an online game.
- At the end of a game, the host sends the result with both players. The game link then shows both names, and the game is in the history of the guest too.
- The host also gives that game link to every connected device, so the end card and the address show the same link on all devices. A guest still keeps its own copy of the result for its stats. The link opens once the host's result reaches the server.
- Host on a laptop: `docker compose -f compose.lan.yml up --build` runs the full game server on a computer. Others on the same network open `http://<that computer's address>:8080` and play the Online mode, with no codes to scan. The online box shows the host with a server icon. Without HTTPS, a browser gives that page no offline cache and no camera; the game itself works. Set `LAN_HOST_NAME` for the name it shows, and `LAN_PORT` when port 8080 is taken.

![A laptop hosts a Nearby game, a phone joins](docs/screenshots/nearby.png)

## Controls per mode

The panel shows a control only in the modes where it applies (`data-show-mode` and `data-needs-session` in `index.html`). A finished game from a link shows only the controls for looking at it.

| Control | Computer | Friend | Online | Nearby | Game from a link |
| --- | --- | --- | --- | --- | --- |
| Opponent, view, layout, theme, sound | yes | yes | yes | yes | yes |
| Difficulty, You play, Advanced | yes | no | no | no | no |
| Game code, Link, QR code, session name | no | no | yes | no | no |
| Host, Join with a code, Games near you, device list | no | no | no | yes | no |
| Join a friend (code and New code) | no | no | yes | no | no |
| Time limit | yes | yes | yes | yes | no |
| Hide board, history and coordinates, Lock | yes | yes | in a game | in a game | no |
| Score, New game, the session games in My games | yes | yes | in a game | in a game | yes (no session games) |
| Undo (during a game) | yes | yes | no | no | no |
| Result card (after a game) | yes | yes | in a game | in a game | no |
| Chat | no | no | yes | yes | no |

- The score and the actions row are at the top of the panel. The row has New game (wide), then Undo during a game or Result card after it, then the sound control. On a phone, the panel is under the board, so this row is right under the board.
- "In a game" means after a create or a join (Online), or after Host or Join (Nearby).
- Join a friend is in the Online mode only. In another mode, a link with `?code=` opens the online game of a friend.
- Nearby has no Join a friend: a code there is an online game, and Nearby has its own Join.

## Accounts and My games

- Login with GitHub is optional. Every browser plays with a random token either way.
- A login links the browser's token to the GitHub account. Sessions then follow the player: a seat taken on a laptop also plays from a phone that logged in to the same account, so an async game can continue on another device.
- A seat taken while logged in belongs to the account: every device of the account controls it, and a device that logs out does not. A logout also moves a seat that holds the token of that browser to the account. The seat holds an account id (`account-` and the GitHub id), and the API refuses that id as an `X-Player` value.
- The score shows a player's GitHub name and avatar, and the chat uses the name.
- A player without a GitHub login gets a generated name: an adjective and an animal in camelCase, such as "braveOtter". The server makes it from the player's token, so every screen shows the same name. A login replaces it with the GitHub name. My games shows the name to its player. The words come from unique-names-generator (MIT).
- The score, the status, the chat, the clocks, the end card and the game links use the same name for each player. The own seat is "You", and a friend game on one screen uses "Player X" and "Player O".
- My games (the button in the header) shows the account, stats per mode and per computer level, the games of the open session with Replay and Card, the match history, the online sessions with a "Your turn" mark and a Continue button, and every session on this device. Offline, it shows the games on this device.
- The login runs on the production address. Its cookie is signed and valid for `tick3d.yarden-zamir.com` and its subdomains, so pull request previews see it too. Without the GitHub settings, login is off and the page hides it.

<img src="docs/screenshots/my-games.png" alt="My games: stats and sessions" width="480">

## Code

- `src/game.ts`: board, lines, move validation, win and draw detection, undo.
- `src/ai.ts`: the three computer levels.
- `src/ai-worker.ts` and `src/move-search.ts`: every level searches in a Web Worker, so the page stays responsive while the computer thinks. The service worker precaches the worker, so the computer also plays offline.
- `src/sound.ts`: synthesized sounds. `src/sound-sets.ts`: the sound sets, as data that `src/sound.ts` plays. `src/page/sound-set.ts`: the sound set menu.
- `src/clock.ts`: time limits and the time left for each player.
- `src/card.ts`: draws the end card on a canvas and shares it.
- `src/protocol.ts`: the contract between the page and the API (code format, names, results, response checks).
- `src/session/core.ts`: the session rules as pure functions. `src/session/format.ts`: the stored session format and its upgrades.
- `src/online.ts`: the API client and the live update stream. `src/local.ts` and `src/device-db.ts`: the device backend on IndexedDB.
- `src/nearby/`: WebRTC connections, QR codes, the messages between host and guests, device kinds, and the host and guest sessions.
- `src/pwa.ts` and `vite.config.ts`: the service worker and the manifest.
- `src/main.ts`, `src/style.css`, `index.html`: the page. `src/main.ts` starts the page; `src/page/` holds the page script, one module per feature (board, sessions, Nearby, My games, clocks, chat and more). `src/page/state.ts` holds the state that more than one module changes.
- `src/icons.ts`: the inline SVG icons that the scripts draw (the lock, the speaker, play). The icons in the HTML pages use the same style. The app uses no emoji, so the icons follow the theme.
- `public/`: the favicons and touch icons, copied into the build as is. The service worker plugin writes the web manifest.
- `server/main.ts`: the HTTP API and server-sent events. `server/lobby.ts`: the list of open Nearby games. `server/store.ts`: the DuckDB store. `server/auth.ts`: GitHub login. `server/previews.ts`: the list of the kitshn button. `server/stats.ts`: the SQL of the stats page. `server/waiters.ts`: the long polls.
- `src/header/`: the header of every page (the account button, kitshn and the My games link). `src/markup.test.ts` checks that every page has the same header markup.
- `stats.html`, `src/stats/`: the hidden stats page.
- `sound-training.html`, `src/sound-training/`: the ear training page. `schedule.ts` picks the cards (Leitner boxes, weakest part first), `deck.ts` draws the board, and `fit.ts` sizes it to the screen.
- `sound-input.html`, `src/sound-input/`: the sound input page. `pitch.ts` finds the pitch of the microphone input (McLeod pitch method), `mapping.ts` places a frequency in the range and turns it into a cell, `sticky.ts` holds a cell against a wobble, `rail.ts` draws the range, `calibration.ts` measures the player's range, `stored.ts` keeps the choices, and the page reuses the deck of the ear training.
- `server/api-docs.ts`: every API route with its shapes, examples and errors, and the guide. The server finds the route of a request in this list, so a route without docs cannot exist. `server/api-docs-render.ts` makes the OpenAPI document and the Swagger UI page. A test runs every example through the real parsers in `src/protocol.ts`, and checks the document against the official OpenAPI 3.1 JSON Schema with `@seriousme/openapi-schema-validator`.
- To add a route: add one entry to `ROUTES` in `server/api-docs.ts` and one case to the switch in `server/main.ts`. The type check fails when one of the two is missing.

The page is plain TypeScript built with Vite, with no runtime dependencies. The API runs on Node 26, which runs TypeScript directly, and stores sessions in [DuckDB](https://duckdb.org) through `@duckdb/node-api`.

## Stored data and format changes

- The `sessions` table has one row per session: the code, a creation order, a version, timestamps, and the session as one `VARIANT` document. `users` and `player_tokens` link browsers to GitHub accounts. `results` holds every finished game, one row per game: the games that devices sent, and the online games, which the server records when they end. Its columns hold the public game id, the token of each seat, the winner, how the game ended and the game metrics. `events` holds the faults that pages report.
- Rows from before game links have NULL in the new columns. The queries read them from `token` and `doc` instead (`SEAT_X` and `SEAT_O` in `server/stats.ts`), and a finished online game that has no row reads from its session. The server never writes data into old rows.
- `hidden_x` and `hidden_o` mark a seat that its player cleared from the history. `seat_metrics` holds the metrics of each player of an online game, one row per seat.
- A device stores its sessions in the same document format in IndexedDB, so the same rules read and upgrade them on a phone.
- The document carries a `format` number. `src/session/format.ts` reads every known format, upgrades old documents step by step, and writes the current format back on the first read.
- A new optional field needs only a default in `parseDoc`. A breaking change needs a new `CURRENT_FORMAT` and one `UPGRADES` step. Neither needs a database reset or a manual migration.
- A server refuses a document from a newer format, so an older server version never overwrites newer data.
- Every write goes through the same check as every read, so the table never holds a document that cannot be read back.
- `src/session/fixtures/` holds a stored document of each released format. A test reads each one, so old data keeps working.
- Table changes are append-only statements such as `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS`, which run on every start.

## API

The full reference, with every shape, error and a curl example, is the OpenAPI 3.1 document at `/api/openapi.json`. `/api/docs` shows it in Swagger UI. It comes from `server/api-docs.ts`. This table is a summary.

| Route | What it does |
| --- | --- |
| `POST /api/sessions`, `GET /api/sessions/:code` and the other session routes | Online play. `GET /api/sessions/:code?wait=<version>` waits for a change. |
| `POST /api/results` | Finished games from a device. The answer holds the new public id of each result that the server renamed. |
| `GET /api/games/:id` | One finished game, read-only. No token and no result id. |
| `GET /api/me/games` | My games: tallies and online sessions. |
| `GET /api/me/history?offset=0` | The match history of the player (by account, else by browser token), 50 games per page, newest first. |
| `GET /api/me/records` | The survival records of the player, with the same keys as on the device (`src/records.ts`). |
| `DELETE /api/me/history` | Clears the history of the player. Needs the X-Player header. |
| `POST /api/games/:id/metrics` | The metrics of a player's device for a finished online game. Only a player of that game may send them, once per seat. |
| `GET /api/nearby/hosts` | The open Nearby games on the network of the caller, without its own. |
| `POST /api/nearby/hosts` | A host puts its Nearby game in the list, and gets its id at once. With the id, the server holds the request until a guest answers, or for about 25 s. Needs the X-Player header. |
| `POST /api/nearby/hosts/:id/answer` | A guest sends its answer to the offer of a host. Needs the X-Player header. |
| `POST /api/events` | A fault report from a page. At most 1 kB, 30 per 10 minutes per address. |
| `GET /api/stats` | The aggregates of the stats page. The server computes them at most once a minute. |
| `GET /api/previews` | The open pull requests with a live preview, for the kitshn button. The server reads GitHub at most once per 2 minutes, without a token. |

## Stats page and what is logged

- `/stats` is a page that nothing links to. It shows games per day, players per day, a weekday and hour heatmap, games by mode, results and survival leaderboards per computer level, game length, time per move (players and computer), the slowest thinkers, first-player advantage, opening moves and all moves over the 4 layers, how games end, hide setting and time limit use, tuned computers, devices, views, layouts, themes, app versions, board and keypad input, refusals, undo use, offline games, Nearby device mixes and page faults. It uses the saved theme. Search engines are told not to list it.
- The page shows counts only. A leaderboard shows the GitHub name of a player with a login, else the generated name. It never shows a token, a result id or a game id.
- What a finished game sends, besides the game itself: the kind of device (phone, tablet or computer), the view, the layout, the theme, how many moves came from the board and from the keypad, the refused actions by reason, the number of undos, the thinking time of each computer move, whether the device was offline, the app version (the file name of the page script), the computer settings of a tuned computer, and for Nearby the role of the device and the kind of the other device.
- A fault report holds the error message with the file name and line, or the reason of a burst of refused moves, and the app version. It holds no token and no address. A page sends at most 10 per visit.
- Each player of an online game sends the same metrics for that game, without the computer and Nearby parts.

## Develop

Node is not necessary on the host. Run the commands in a container:

```sh
docker run --rm -v "$PWD":/app -w /app node:26-alpine sh -c 'npm ci && npm run check && npm run build'
docker run --rm -it -p 5173:5173 -v "$PWD":/app -w /app node:26-alpine npx vite --host
```

`npm run check` runs the type check, every linter and the tests. `npm run build` runs the type check (`tsc`) before the Vite build. `npm run api` starts the API on port 8080 with `./dev.duckdb`.

`npm run lint` runs these checks. Each one catches faults that the type check does not:

- [oxlint](https://oxc.rs) with type-aware rules (`.oxlintrc.json`). It runs on the TypeScript 7 checker through `oxlint-tsgolint`. typescript-eslint does not support TypeScript 7. The rules catch promises that nobody awaits or catches, promises passed where a function must return nothing, switches that miss a case, and needless type assertions. Style rules are off.
- [stylelint](https://stylelint.io) with `stylelint-config-recommended` (`.stylelintrc.json`): unknown properties, invalid values and duplicate selectors in the CSS. No style rules.
- [html-validate](https://html-validate.org) (`.htmlvalidate.json`): invalid markup and accessibility faults in `index.html`, such as a button without a name or an input without a type.
- [Knip](https://knip.dev): files, exports and packages that nothing uses.

`npm run e2e` runs the Playwright tests in `e2e/` against a deployed site in Chromium. Set `E2E_BASE_URL` to the site, for example a pull request preview. Without it, the run stops at once. Run the tests in the Playwright image:

```sh
docker run --rm --ipc=host -v "$PWD":/app -w /app -e E2E_BASE_URL=https://pr.17.tick3d.yarden-zamir.com mcr.microsoft.com/playwright:v1.63.0-noble sh -c 'npm ci && npm run e2e'
```

- The image tag must match the `@playwright/test` version in `package.json`. Update both together.
- `npm ci` in the Playwright image installs packages for glibc. Run `npm ci` again before you use `node:26-alpine`.
- Each test opens fresh browser contexts, and the tests run in parallel. The HTML report goes to `e2e/playwright-report/`. A failed test keeps a trace in `e2e/test-results/`.
- One run creates 8 online sessions. The server allows 60 new sessions per hour from one address.
- The `e2e` workflow runs the suite after a successful pull request preview deploy. When a test fails, the workflow uploads the HTML report.
- Knip finds the tests through its `entry` setting in `package.json`. Its Playwright plugin is off, because the plugin loads the config, and the config stops without `E2E_BASE_URL`.
- The laptop host (`compose.lan.yml`) has no automatic test. It needs a local Docker host and a second device on the network.

## Deploy

See [kitshn.md](kitshn.md). A push to `main` deploys production.
