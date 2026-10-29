import { defineApp } from "kitshn";

// kitshn 2 (https://kit.yarden-zamir.com): a Compose app on a machine labelled "docker", public like before.
// Previews live at tick3d-pr-<n>.yarden-zamir.com and are public too, so anyone with the link can try one.
export default defineApp({
  compose: { runsOn: ["docker"] },
  deploy: [
    { on: "push", branch: "main", name: "prod", startsIn: "Everyone" },
    { on: "pull_request", name: "pr-{pr}", ephemeral: true, startsIn: "Everyone" },
  ],
});
