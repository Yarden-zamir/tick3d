# tick3d Factory

The tick3d repository as an automated 3D factory, in a Unity-style editor. Local only: `/factory/`
is in the repository's `.gitignore`, and nothing here is committed or deployed.

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
