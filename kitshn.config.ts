import { defineApp } from "kitshn";

// kitshn 2 (https://kit.yarden-zamir.com): a Compose app on a machine labelled "docker", public like before.
// Previews move from pr-<n>.tick3d.yarden-zamir.com to tick3d-pr-<n>.yarden-zamir.com and start private.
export default defineApp({
  compose: { runsOn: ["docker"] },
  deploy: [
    { on: "push", branch: "main", name: "prod", startsIn: "Everyone" },
    { on: "pull_request", name: "pr-{pr}", ephemeral: true },
  ],
});
