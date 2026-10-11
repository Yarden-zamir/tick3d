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
- Dev endpoints: `/__factory` (a fresh scan), `/__source?path=` (a tracked file, for the Inspector),
  `/__snapshot` (`factory.snap()` in the browser console saves a frame to `.snapshots/`).
- Walk mode (`P` or the 🚶 tool): first person on the factory floor. The mouse looks around, WASD
  walks, Shift runs, Space jumps, a click or `E` selects what the crosshair is on, and Esc leaves.
  `src/walk.ts` handles the movement and collisions with machines, posts and trees.
