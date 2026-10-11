# tick3d Factory

The tick3d repository as an automated 3D factory, in a Unity-style editor. A separate npm project:
the site, the API and the Docker image don't include it, and nothing here is deployed.

```sh
cd factory
npm install
npm run dev        # scans the repo, then serves http://localhost:5199
```

- `scan/scan.ts` reads the checkout (git ls-files, imports, ROUTES, the DuckDB tables, the workflows,
  the Dockerfile, the compose files, every package.json) and builds the model. Nothing is hand-placed:
  a new file, import, route, table or job shows up after Rescan.
- `src/lore.ts` holds the explanations of each zone and the scenarios (real code paths).
- `src/layout.ts` places zones and machines; `src/world/` draws them; `src/ui/` is the editor.
- Everything in the world stands for something real, and the Legend and the Inspector say what:
  - `world/styles.ts`: each zone's building, in a style that says what the zone does.
  - `world/belts.ts` and `world/pipes.ts`: belts carry imports (discrete pieces of code); pipes carry
    what flows (rows into tables, CSS, the volume, the event stream); pneumatic tubes carry HTTP calls
    (the scanner matches the client's `/api/...` calls to `ROUTES`).
  - `world/power.ts`: what runs each zone's code. Windmills are the browser, the water wheel the Node
    server, the AI Lab's own windmill the Web Worker, steam engines the GitHub Actions runners.
  - `world/landscape.ts` and `world/deliveries.ts`: the river is the internet, the canal's sluice gate
    is Caddy, trucks bring npm packages, the train deploys Docker images, ships take the apps to the
    stores, a cable car carries Worker messages, radio pulses are WebRTC, pigeons BroadcastChannel.
- Dev endpoints: `/__factory` (a fresh scan), `/__source?path=` (a tracked file, for the Inspector),
  `/__snapshot` (`factory.snap()` in the browser console saves a frame to `.snapshots/`).
- Walk mode (`P` or the 🚶 tool): first person on the factory floor. The mouse looks around, WASD
  walks, Shift runs, Space jumps, a click or `E` selects what the crosshair is on, and Esc leaves.
  `src/walk.ts` handles the movement and collisions with machines, posts and trees.
