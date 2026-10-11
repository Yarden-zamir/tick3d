// The words of the factory: what each zone is, what each kind of machine and belt means, and the
// scenarios that play a real path through the code. The scanner supplies every name, size and link;
// this file only explains them. Each claim here comes from the README, kitshn.md or the code itself.

import type { EdgeKind, EntityKind, ZoneId } from '../scan/model.ts';

export interface ZoneLore {
  title: string;
  /** What part of the repository the zone holds. */
  holds: string;
  color: string;
  icon: string;
  /** The row of the map, top (north) to bottom (south). */
  row: number;
  story: string[];
  facts: string[];
}

export const ZONES: Record<ZoneId, ZoneLore> = {
  materials: {
    title: 'Raw Materials Dock',
    holds: 'package.json, the lockfile, tsconfig, README, docs/',
    color: '#b5835a',
    icon: '⛁',
    row: 0,
    story: [
      'Every crate here is an npm package that the root project declares. Barrels are runtime packages, crates are dev tools.',
      'The page ships no runtime packages: it is plain TypeScript built by Vite. The only runtime package of the whole product is @duckdb/node-api, which feeds the API plant.',
    ],
    facts: ['Node 26 runs the API TypeScript directly: it strips the types, so there is no compile step on the server.', 'npm run check = tsc + oxlint + stylelint + html-validate + knip + vitest.'],
  },
  studio: {
    title: 'Film Studio',
    holds: 'video/: the 15 s ad and the “How to win” tutorial',
    color: '#d65db1',
    icon: '🎬',
    row: 0,
    story: [
      'A separate npm project. three.js draws every frame, Remotion renders it, and the soundtrack comes from the game’s own sound code (src/song.ts, src/sound.ts, src/sound-sets.ts). The belts from the Acoustics Wing are real imports.',
      'beats.json is the timeline. A variant is a small overlay on it that changes themes, sound sets, camera and text, never the game.',
    ],
    facts: ['The video workflow checks the code on PRs and renders every variant on main and on tags.', 'video/scripts/publish.sh publishes renders to the pr-assets branch, one folder per commit.'],
  },
  storefront: {
    title: 'Storefronts',
    holds: 'The 5 HTML pages, src/header/, src/stats/, src/privacy/',
    color: '#ff9f43',
    icon: '🏪',
    row: 1,
    story: [
      'Each storefront is one page of the site: / (the game), /stats, /sound-training, /sound-input and /privacy. src/pages.ts lists them, and the build makes one entry per page.',
      'Every page wears the same header (src/header/). src/markup.test.ts checks that.',
    ],
    facts: ['Caddy rewrites /stats to stats.html, so addresses have no .html.', 'The stats page is public and shows counts only for Everyone.'],
  },
  assembly: {
    title: 'Page Assembly Hall',
    holds: 'src/main.ts, src/page/*, src/board/*, style.css: the game page',
    color: '#ffd23f',
    icon: '🏭',
    row: 1,
    story: [
      'One workstation per feature of the game page: the board, the players box, chat, clocks, the end card, settings, safety menus and more.',
      'src/main.ts wires them up: every module only declares things on import, and main.ts adds the listeners and builds the page.',
      'src/page/sessions.ts is the dispatcher: a move goes to the backend of the mode (online, device or Nearby).',
    ],
    facts: ['No framework: plain DOM and TypeScript.', 'The action row has fixed slots, so a control that shows or hides never moves another one.'],
  },
  foundry: {
    title: 'Rules Foundry',
    holds: 'src/game.ts, src/session/, src/protocol.ts, src/practice/',
    color: '#ff5e3a',
    icon: '🔥',
    row: 1,
    story: [
      'The heart of the factory. src/game.ts holds the 4×4×4 board and the 76 winning lines. src/session/core.ts holds the session rules: seats, turns, clocks, undo and locks.',
      'The same code runs in three places: the API server, the device (computer and friend games), and the Nearby host. That is why belts leave this foundry for the API plant, the client depot and the radio tower.',
      'src/protocol.ts is the contract between the page and the API. Both sides import it.',
    ],
    facts: ['A stored session has a format number. A breaking change needs a new CURRENT_FORMAT and an UPGRADES step (src/session/format.ts).', 'src/session/fixtures/ keeps one document of each released format.'],
  },
  api: {
    title: 'API Plant',
    holds: 'server/: the Node HTTP API',
    color: '#4d7cfe',
    icon: '⚙',
    row: 1,
    story: [
      'Each loading dock is one route of ROUTES in server/api-docs.ts. Green doors are GET, blue POST, amber PUT/PATCH and red DELETE.',
      'server/main.ts finds the route in that list and runs one case of its switch. The type check fails when a route misses either side.',
      'Live updates: an open page holds an event stream (GET …/events). On a change the server writes “data: changed”, wakes the long polls (server/waiters.ts), and the page fetches the session again.',
    ],
    facts: ['Routes that change a game accept an Idempotency-Key header (server/idempotency.ts).', 'Every 429 has Retry-After.', '/api/openapi.json and /api/docs come from the same ROUTES list.'],
  },
  vault: {
    title: 'DuckDB Vault',
    holds: 'The tables of server/store.ts and the sessions volume',
    color: '#18b7a0',
    icon: '🛢',
    row: 1,
    story: [
      'Each silo is a table that server/store.ts creates on start. A silo is taller when the table has more columns.',
      'A session is stored as one document in the sessions table, the same format the device keeps in IndexedDB.',
      'The tank is the Docker volume that holds /data/tick3d.duckdb. Each kitshn environment has its own.',
    ],
    facts: ['Table changes are append-only statements, such as ALTER TABLE … ADD COLUMN IF NOT EXISTS.', 'DuckDB allows one process: stop the api service before you query the file by hand.'],
  },
  acoustics: {
    title: 'Acoustics Wing',
    holds: 'Sound, songs, the voice engine, the Voice room and the ear trainer',
    color: '#a06cf5',
    icon: '♫',
    row: 2,
    story: [
      'Every sound is synthesized with Web Audio, so the app ships no audio files. A sound set gives each cell its own note.',
      'src/voice/ finds the pitch on the device (no sound leaves it): hold a note on a free cell for 1 second to place a move.',
      'src/song.ts turns a finished game into a short piece of music, and src/wav.ts writes it as a WAV file.',
    ],
    facts: ['/sound-input is the Voice room; /sound-training is the ear trainer.', 'One sound rule on every page: src/click-sound.ts.'],
  },
  ai: {
    title: 'AI Lab',
    holds: 'src/ai.ts, src/ai-worker.ts, src/move-search.ts, src/tuning.ts',
    color: '#ff477e',
    icon: '🧠',
    row: 2,
    story: [
      'The computer player thinks in a sealed room: a Web Worker (src/ai-worker.ts), so the page stays responsive.',
      'src/ai.ts weighs every line by how many marks one player has in it. src/tuning.ts holds every number of the three levels, and “Advanced: computer player” can change them.',
    ],
    facts: ['Three levels: easy, medium and hard.', 'Survival records count the longest game against each level.'],
  },
  nearby: {
    title: 'Nearby Radio Tower',
    holds: 'src/nearby/: WebRTC, QR codes and the host and guest sessions',
    color: '#00c2ff',
    icon: '📡',
    row: 2,
    story: [
      'Devices on the same Wi-Fi play directly over a WebRTC data channel. The host’s device holds the session and checks every move with the same core rules as the server.',
      'Online, the host announces itself to the lobby (server/lobby.ts) so that other devices of the same network see it. Offline, the devices swap QR codes or text codes.',
    ],
    facts: ['rpc.ts runs calls over the data channel.', 'compose.lan.yml can host a full server on a laptop.'],
  },
  device: {
    title: 'Client Depot',
    holds: 'Offline storage, the API client and the service worker',
    color: '#7f9cc0',
    icon: '📦',
    row: 2,
    story: [
      'src/online.ts is the API client. src/local.ts is the device backend: computer and friend games, and hosted Nearby games, stored in IndexedDB (src/device-db.ts).',
      'src/pwa.ts and the Workbox service worker keep the app shell on the device, so the game opens and plays offline. Results upload when the network returns.',
    ],
    facts: ['Safari deletes site data after 7 days unless the game is on the home screen.', 'After a deploy the page offers “A new version of tick3d is ready”.'],
  },
  qa: {
    title: 'QA Proving Ground',
    holds: 'e2e/ Playwright specs and the lint configs',
    color: '#b8e04a',
    icon: '✔',
    row: 2,
    story: [
      'The drones are Playwright specs. After each successful PR preview deploy, the e2e workflow waits for 3 healthy answers in a row, then flies them at the preview.',
      'Unit tests are not here: each one is the green scanner arch inside the machine it tests.',
    ],
    facts: ['Keep the Playwright image tag equal to @playwright/test.', 'e2e/ios.spec.ts checks what the iOS app hides.'],
  },
  ci: {
    title: 'Control Tower',
    holds: 'kitshn.yml, .kitshn.yaml, dependabot',
    color: '#e9e9e9',
    icon: '🗼',
    row: 3,
    story: [
      'The kitshn workflow is the main gate: check (type check, linters, tests, build), then deploy for main, and preview for pull requests, through kitshn’s reusable deploy workflow.',
      '.kitshn.yaml maps events to environments: a push to main → prod, a pull request → an ephemeral pr-<n>.',
    ],
    facts: ['A PR with the label no-preview gets no preview.', 'Dependabot runs get no deploy secrets.'],
  },
  packaging: {
    title: 'Packaging & Shipping',
    holds: 'Dockerfile, compose files, Caddy, vite.config.ts',
    color: '#2496ed',
    icon: '🚢',
    row: 3,
    story: [
      'Three Docker stages: build (npm ci + vite build, with release.json from the git commit), api (Node 26 Alpine + the DuckDB package only), and site (Caddy + dist/).',
      'Compose runs site and api. The site container’s Caddy binds the kitshn Unix socket; the host Caddy terminates TLS and proxies to it. /api/* goes on to api:8080.',
    ],
    facts: ['Services publish no host ports.', 'api has a healthcheck on /api/health; site waits for it.'],
  },
  android: {
    title: 'Android Export Dock',
    holds: 'android/ (TWA), the play-* workflows, src/assetlinks.ts',
    color: '#3ddc84',
    icon: '🤖',
    row: 3,
    story: [
      'The paid Google Play app wraps the production site as a Trusted Web Activity. Bubblewrap generates the Android project from twa-manifest.json on every build.',
      'The play-* workflows release it, promote it, sync the listing, render store screenshots, and file issues from reviews and crashes every day.',
      'src/assetlinks.ts writes /.well-known/assetlinks.json, which proves to Android that the app and the site belong together.',
    ],
    facts: ['play-feedback runs daily at 06:17 UTC.', 'play-signing checks the signing fingerprint every Monday at 05:41 UTC.'],
  },
  ios: {
    title: 'iOS Export Dock',
    holds: 'apple/ (Capacitor), ios.yml, src/platform.ts',
    color: '#a7b0bd',
    icon: '',
    row: 3,
    story: [
      'The iOS app wraps the production site with Capacitor. The workflow generates the Xcode project on every run, so the repository keeps no native code.',
      'A tag ios-v* builds, signs and uploads to TestFlight. The distribute job then calls the App Store Connect API (apple/scripts/testflight-distribute.py) to add the build to the external Testers group and submit it for Beta App Review.',
      'src/platform.ts sees tick3dApp/ios in the user agent and hides what the App Store does not allow.',
    ],
    facts: ['A PR that touches apple/ runs the lint job: actionlint plus the same Capacitor generation, with no macOS runner.', 'WKAppBoundDomains lets the web view run the service worker.'],
  },
};

export const ZONE_ORDER = Object.keys(ZONES) as ZoneId[];

export const KINDS: Record<EntityKind, { name: string; machine: string; meaning: string }> = {
  module: { name: 'Module', machine: 'Assembler', meaning: 'A TypeScript source file. Height grows with its line count.' },
  test: { name: 'Unit test', machine: 'Scanner arch', meaning: 'A vitest file. It stands inside the machine it tests.' },
  spec: { name: 'E2E spec', machine: 'Drone pad', meaning: 'A Playwright spec that runs against a deployed preview.' },
  style: { name: 'Stylesheet', machine: 'Paint mixer', meaning: 'A CSS file.' },
  page: { name: 'HTML page', machine: 'Storefront', meaning: 'An entry page of the site.' },
  config: { name: 'Config', machine: 'Control cabinet', meaning: 'JSON, YAML or another settings file.' },
  doc: { name: 'Document', machine: 'Notice board', meaning: 'Markdown or text.' },
  asset: { name: 'Asset', machine: 'Crates', meaning: 'An image, font, fixture or other data file.' },
  script: { name: 'Script', machine: 'Robot arm', meaning: 'A shell, Python or Ruby script.' },
  route: { name: 'API route', machine: 'Loading dock', meaning: 'One entry of ROUTES in server/api-docs.ts.' },
  table: { name: 'DuckDB table', machine: 'Silo', meaning: 'A CREATE TABLE in server/store.ts.' },
  volume: { name: 'Docker volume', machine: 'Tank', meaning: 'A named volume in a compose file.' },
  workflow: { name: 'Workflow', machine: 'Signal tower', meaning: 'A GitHub Actions workflow file. Each light is a trigger.' },
  job: { name: 'Workflow job', machine: 'Press station', meaning: 'A job of a workflow. Height grows with its steps.' },
  stage: { name: 'Docker stage', machine: 'Container', meaning: 'A FROM … AS stage of the Dockerfile.' },
  service: { name: 'Compose service', machine: 'Container crane', meaning: 'A service of compose.yml or compose.lan.yml.' },
  dep: { name: 'npm package', machine: 'Barrel / crate', meaning: 'A dependency in a package.json. Barrels are runtime, crates are dev.' },
  hub: { name: 'Zone hub', machine: 'Hub', meaning: 'Where the zone’s belts join the overhead trunk lines.' },
};

export const EDGES: Record<EdgeKind, { name: string; color: string; meaning: string }> = {
  import: { name: 'Import', color: '#d9d9d9', meaning: 'Code travels from the imported file to the importer.' },
  package: { name: 'Package', color: '#b5835a', meaning: 'An npm package feeds the file that imports it.' },
  stores: { name: 'Stores', color: '#18b7a0', meaning: 'The store writes rows into the table.' },
  needs: { name: 'Needs', color: '#e9e9e9', meaning: 'A job starts after the job it needs.' },
  stage: { name: 'Docker COPY', color: '#2496ed', meaning: 'A file or stage is copied into a Docker stage.' },
  serves: { name: 'Serves', color: '#58a6ff', meaning: 'A stage runs as a service, a service depends on another, or mounts a volume.' },
  entry: { name: 'Entry', color: '#ff9f43', meaning: 'An HTML page loads its script or style.' },
};

export interface ScenarioStep {
  at: string;
  say: string;
}

export interface Scenario {
  id: string;
  title: string;
  steps: ScenarioStep[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'online-move',
    title: 'Online: X places a mark',
    steps: [
      { at: 'src/board/board.ts', say: 'A player clicks a free cell on the 3D tower.' },
      { at: 'src/page/sessions.ts', say: 'sessions.ts sends the move to the backend of the mode: online.' },
      { at: 'src/online.ts', say: 'online.ts: fetch POST /api/sessions/AB3K/moves, with the X-Player token and an Idempotency-Key.' },
      { at: 'service:compose.yml#site', say: 'The site container’s Caddy matches /api/* and proxies it to api:8080.' },
      { at: 'server/main.ts', say: 'route(): matchRoute finds the entry in ROUTES, then the switch case runs.' },
      { at: 'route:POST /api/sessions/{code}/moves', say: 'parseMoveRequest checks game, moveCount and cell, or answers 400.' },
      { at: 'server/idempotency.ts', say: 'A retry with the same key gets the stored answer, so a move never lands twice.' },
      { at: 'server/store.ts', say: 'store.move → change(code, token, doc => core.move(doc, identity, request, now())).' },
      { at: 'src/session/core.ts', say: 'core.move checks the seat, the turn, the lock and the clock.' },
      { at: 'src/game.ts', say: 'game.ts places the mark and checks the 76 lines for a win or a full cube.' },
      { at: 'table:sessions', say: 'The new session document is written, and its version goes up by one.' },
      { at: 'server/waiters.ts', say: 'notify(code): each event stream gets “data: changed”, and the long polls wake.' },
      { at: 'route:GET /api/sessions/{code}', say: 'Both pages fetch the session again.' },
      { at: 'src/page/render.ts', say: 'render() redraws the board, the clocks and the players on both screens.' },
    ],
  },
  {
    id: 'computer-move',
    title: 'Computer: the AI answers',
    steps: [
      { at: 'src/page/computer.ts', say: 'It is the computer’s turn. computer.ts asks the move search.' },
      { at: 'src/move-search.ts', say: 'move-search.ts posts the board, the level and the tuning to the worker.' },
      { at: 'src/ai-worker.ts', say: 'The Web Worker thinks off the main thread, so the page stays responsive.' },
      { at: 'src/tuning.ts', say: 'The numbers of the chosen level (or the ones changed in Advanced).' },
      { at: 'src/ai.ts', say: 'chooseMove weighs each line by the marks one player has in it.' },
      { at: 'src/game.ts', say: 'Candidate moves are checked with the same board rules.' },
      { at: 'src/page/sessions.ts', say: 'The answer comes back and goes to the device backend.' },
      { at: 'src/local.ts', say: 'local.ts applies the move with the same core rules as the server.' },
      { at: 'src/session/core.ts', say: 'core.move: seat, turn and clock checks, exactly as online.' },
      { at: 'src/device-db.ts', say: 'The session is saved in IndexedDB, so it survives a reload, even offline.' },
      { at: 'src/page/render.ts', say: 'The board shows the computer’s mark.' },
    ],
  },
  {
    id: 'push-main',
    title: 'Push to main → production',
    steps: [
      { at: '.github/workflows/kitshn.yml', say: 'A push to main starts the kitshn workflow.' },
      { at: 'job:kitshn.yml#check', say: 'check: npm ci, npm run check (tsc, linters, knip, vitest), npm run build.' },
      { at: 'job:kitshn.yml#deploy', say: 'deploy waits for a passing check, then calls kitshn’s reusable deploy.yml.' },
      { at: '.kitshn.yaml', say: '.kitshn.yaml: a push to main is the prod environment.' },
      { at: 'stage:build', say: 'Docker stage build: npm ci, then vite build. release.json takes its name from the commit.' },
      { at: 'stage:api', say: 'Stage api: runtime packages only, plus src/ and server/, with the tests removed.' },
      { at: 'stage:site', say: 'Stage site: Caddy with container/Caddyfile and dist/.' },
      { at: 'service:compose.yml#api', say: 'api starts on the sessions volume and answers its /api/health check.' },
      { at: 'service:compose.yml#site', say: 'site starts after api is healthy and binds the kitshn socket.' },
      { at: 'Caddyfile.j2', say: 'The host Caddy terminates TLS for tick3d.yarden-zamir.com.' },
      { at: 'src/pwa.ts', say: 'Open pages see “A new version of tick3d is ready”. The apps get it with no app build.' },
    ],
  },
  {
    id: 'pr-preview',
    title: 'Pull request → preview + e2e',
    steps: [
      { at: 'job:kitshn.yml#preview', say: 'A pull request starts its preview at once, next to the check.' },
      { at: '.kitshn.yaml', say: 'pr-{pr}, ephemeral: it is torn down when the PR closes.' },
      { at: 'stage:build', say: 'The same image build, with “(pr-<n>)” in the release name.' },
      { at: 'service:compose.yml#site', say: 'The preview goes live at pr-<n>.tick3d.yarden-zamir.com.' },
      { at: 'job:e2e.yml#e2e', say: 'deployment_status starts e2e. It waits for 3 healthy answers in a row.' },
      { at: 'e2e/online.spec.ts', say: 'Playwright plays online games against the preview.' },
      { at: 'e2e/ios.spec.ts', say: 'and checks what the iOS app must hide.' },
      { at: 'server/previews.ts', say: 'The kitshn button lists the open previews (prod asks GitHub; previews ask prod).' },
    ],
  },
  {
    id: 'ios-tag',
    title: 'Tag ios-v* → TestFlight',
    steps: [
      { at: '.github/workflows/ios.yml', say: 'A tag ios-v1.2.0 starts the ios workflow.' },
      { at: 'job:ios.yml#app', say: 'app (macos-15): Capacitor generates the Xcode project, archives, signs in the cloud and uploads.' },
      { at: 'apple/capacitor.config.json', say: 'The app is a web view of the production site.' },
      { at: 'apple/www/index.html', say: 'Shown only when the first start has no network.' },
      { at: 'job:ios.yml#distribute', say: 'After a real upload: distribute.' },
      { at: 'apple/scripts/testflight-distribute.py', say: 'A JWT signed with the Admin key: add the build to “Testers”, submit for Beta App Review.' },
      { at: 'src/platform.ts', say: 'In the app the page sets data-platform="ios" and hides GitHub links and login.' },
    ],
  },
  {
    id: 'android',
    title: 'Android: build, release, listen',
    steps: [
      { at: '.github/workflows/android.yml', say: 'The android workflow builds the TWA.' },
      { at: 'job:android.yml#bundle', say: 'Bubblewrap generates the project, then the bundle is signed and uploaded to Google Play.' },
      { at: 'android/twa-manifest.json', say: 'The app identity: the package id and the signing fingerprints.' },
      { at: 'src/assetlinks.ts', say: 'The site serves /.well-known/assetlinks.json from the same manifest.' },
      { at: 'job:play-promote.yml#promote', say: 'play-promote moves a release to the next track: internal → closed → production.' },
      { at: 'job:play-feedback.yml#feedback', say: 'Every day: reviews, crashes and ANRs become GitHub issues.' },
    ],
  },
  {
    id: 'nearby',
    title: 'Nearby: two devices, one Wi-Fi',
    steps: [
      { at: 'src/page/nearby.ts', say: 'One device taps Host.' },
      { at: 'route:POST /api/nearby/hosts', say: 'Online, the host announces the game.' },
      { at: 'server/lobby.ts', say: 'The lobby groups hosts by network, so only devices on the same network see it.' },
      { at: 'route:GET /api/nearby/hosts', say: 'The other device lists “Games near you” every few seconds.' },
      { at: 'src/nearby/signal.ts', say: 'The offer and the answer are encoded (or shown as QR codes offline).' },
      { at: 'src/nearby/peer.ts', say: 'A WebRTC data channel opens, directly between the devices.' },
      { at: 'src/nearby/rpc.ts', say: 'Moves travel as calls over the channel.' },
      { at: 'src/nearby/session.ts', say: 'The host holds the session.' },
      { at: 'src/session/core.ts', say: 'and checks every move with the same rules as the server.' },
      { at: 'src/local.ts', say: 'The hosted session lives in the host’s device backend.' },
    ],
  },
  {
    id: 'results',
    title: 'Offline game → stats',
    steps: [
      { at: 'src/device-db.ts', say: 'A finished offline game waits in IndexedDB.' },
      { at: 'src/page/results.ts', say: 'With a network, the waiting results are collected.' },
      { at: 'src/online.ts', say: 'uploadResults: POST /api/results in batches.' },
      { at: 'route:POST /api/results', say: 'The server checks each result.' },
      { at: 'server/store.ts', say: 'The store writes them.' },
      { at: 'table:results', say: 'One row per finished game.' },
      { at: 'server/stats.ts', say: 'GET /api/stats aggregates them in DuckDB SQL: counts only for Everyone.' },
      { at: 'stats.html', say: '/stats shows the totals, and Mine adds your own trends.' },
    ],
  },
  {
    id: 'voice',
    title: 'Play by voice',
    steps: [
      { at: 'src/voice/microphone.ts', say: 'The mic opens. No sound leaves the device.' },
      { at: 'src/voice/pitch.ts', say: 'The pitch is found on the device.' },
      { at: 'src/voice/engine.ts', say: 'The voice engine maps the note to a cell of your range.' },
      { at: 'src/page/voice.ts', say: 'Hold the note on a free cell for 1 second.' },
      { at: 'src/page/sessions.ts', say: 'humanMove: the move goes to the backend like a click.' },
      { at: 'src/song.ts', say: 'After the game, the Song button plays it back, with your voice on the voiced moves.' },
    ],
  },
  {
    id: 'video',
    title: 'Render the ad',
    steps: [
      { at: 'video/creative/beats.json', say: 'The timeline of the 15 s spot.' },
      { at: 'video/scripts/render.ts', say: 'npm run video starts the render.' },
      { at: 'video/src/Root.tsx', say: 'Remotion compositions: landscape and portrait.' },
      { at: 'video/src/world.ts', say: 'three.js draws the cube in every frame.' },
      { at: 'video/src/soundtrack.ts', say: 'The soundtrack comes from the game’s own code.' },
      { at: 'src/sound.ts', say: 'The same Web Audio voices as the game.' },
      { at: 'video/scripts/publish.sh', say: 'publish.sh puts the renders on the pr-assets branch.' },
    ],
  },
];
