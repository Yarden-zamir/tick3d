// The tick3d Factory: the repository as an automated factory, in a Unity-style editor.
// main.ts loads the scan, builds the world and the panels, and runs the loop.

import './ui/ui.css';
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Entity, FactoryModel, ZoneId } from '../scan/model.ts';
import { computeLayout } from './layout.ts';
import { KINDS, SCENARIOS, ZONES, ZONE_ORDER, type Scenario } from './lore.ts';
import { type ModelIndex, type Selection, indexModel, sameSelection } from './model.ts';
import { Clock, parseCrons, pickRoute, samplePath, statusFor } from './sim.ts';
import { createAxisGizmo } from './ui/axis-gizmo.ts';
import { createConsole } from './ui/console.ts';
import { createHierarchy } from './ui/hierarchy.ts';
import { createInspector } from './ui/inspector.ts';
import { createWalker } from './walk.ts';
import { type BeltMode, buildBelts } from './world/belts.ts';
import { buildLandscape } from './world/landscape.ts';
import { buildPipes } from './world/pipes.ts';
import { buildPower } from './world/power.ts';
import { buildDeliveries } from './world/deliveries.ts';
import { createRouter } from './world/routes.ts';
import { createEffects } from './world/effects.ts';
import { METHOD_COLORS, buildMachines } from './world/machines.ts';
import { createStage } from './world/stage.ts';

const $ = <T extends HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
};

async function loadModel(): Promise<FactoryModel> {
  for (const url of ['/__factory', '/factory.json']) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return (await response.json()) as FactoryModel;
    } catch {
      // Try the next source.
    }
  }
  throw new Error('No factory model. Run npm run scan, or start the dev server with npm run dev.');
}

const SAVED = 'tick3d-factory-view';

async function start(): Promise<void> {
  const model = await loadModel();
  const index: ModelIndex = indexModel(model);
  const layout = computeLayout(model);
  const extent = Math.max(layout.bounds.maxX - layout.bounds.minX, layout.bounds.maxZ - layout.bounds.minZ);

  // World.
  const viewport = $<HTMLDivElement>('#viewport');
  // Strips kept free of trees: the river with the railway on its bank, and the highway from the west.
  const firstRowSouth = Math.max(...[...layout.plots.values()].filter((plot) => plot.minZ === layout.bounds.minZ).map((plot) => plot.maxZ));
  const clearings = [
    { minX: -Infinity, maxX: Infinity, minZ: layout.bounds.maxZ + 10, maxZ: layout.bounds.maxZ + 54 },
    { minX: -Infinity, maxX: layout.bounds.minX, minZ: firstRowSouth + 3, maxZ: firstRowSouth + 18 },
  ];
  const stage = createStage(viewport, extent, layout.bounds, clearings);
  const machines = buildMachines(model, layout);
  stage.scene.add(machines.group);
  const router = createRouter(layout, machines.hubs);
  const belts = buildBelts(model, layout, router, stage.time);
  stage.scene.add(belts.group);
  const pipes = buildPipes(model, layout, router, stage.time);
  stage.scene.add(pipes.group);
  const landscape = buildLandscape(layout, router, belts.roads, extent, stage.time);
  stage.scene.add(landscape.group);
  const power = buildPower(model, layout, machines.ceilings, landscape);
  stage.scene.add(power.group);
  const deliveries = buildDeliveries(model, layout, landscape);
  stage.scene.add(deliveries.group);
  for (const { text, at, color } of landscape.labels) {
    const div = document.createElement('div');
    div.className = 'zlabel';
    div.style.setProperty('--c', color);
    div.textContent = text;
    const label = new CSS2DObject(div);
    label.position.copy(at);
    stage.scene.add(label);
  }
  const effects = createEffects(stage.scene);
  stage.sun.target.position.set(0, 0, 0);

  // Walk mode: first person on the factory floor. The orbit view comes back on leaving.
  const walkHud = $<HTMLDivElement>('#walk-hud');
  const walkPaused = $<HTMLDivElement>('#walk-paused');
  const walkTarget = $<HTMLDivElement>('#walk-target');
  const walkZone = $<HTMLDivElement>('#walk-zone');
  const orbit = { camera: new THREE.Vector3(), target: new THREE.Vector3() };
  const walkBoxes = [...machines.bounds.values(), ...machines.solids, ...landscape.solids];
  const walker = createWalker({
    camera: stage.camera,
    canvas: stage.renderer.domElement,
    boxes: () => walkBoxes,
    posts: [...machines.posts, ...landscape.posts, ...power.posts, ...stage.trees],
    limit: extent * 1.3,
    onChange(active) {
      walkHud.hidden = !active;
      walkPaused.hidden = true;
      document.body.classList.toggle('walking', active);
      for (const tool of document.querySelectorAll<HTMLButtonElement>('.tool')) {
        if (tool.dataset.tool === 'walk') tool.classList.toggle('active', active);
        if (tool.dataset.tool === 'orbit') tool.classList.toggle('active', !active);
      }
      stage.controls.enabled = !active;
      $<HTMLDivElement>('#tooltip').hidden = true;
      if (!active) {
        stage.camera.position.copy(orbit.camera);
        stage.controls.target.copy(orbit.target);
        stage.controls.update();
        state.hover = null;
        effects.hover(null);
      }
    },
    onLockChange(locked) {
      walkPaused.hidden = !walker.active || locked;
    },
  });

  // State.
  const state = {
    selection: null as Selection,
    hover: null as string | null,
    playing: true,
    speed: 1,
    beltMode: 'all' as BeltMode,
    typeOnly: true,
    labels: true,
    roofs: 'auto' as 'auto' | 'off' | 'on',
    light: 'day' as 'cycle' | 'day' | 'night',
    follow: true,
  };
  const activity = new Map<string, number>();
  const clock = new Clock();
  const crons = parseCrons(model.entities.filter((entity) => entity.kind === 'workflow'));
  const routes = model.entities.filter((entity) => entity.kind === 'route');

  // Panels.
  const consolePanel = createConsole($('#bottom'), (selection) => select(selection, true));
  const log = consolePanel.log;
  const hierarchy = createHierarchy($('#tree'), $<HTMLInputElement>('#search'), [...document.querySelectorAll<HTMLElement>('#left .tab')], index, (selection) => select(selection, false), (selection) => select(selection, true));
  const inspector = createInspector($('#inspector'), () => index, () => layout.places, (selection) => select(selection, true), () => power.sources);
  $('#repo-chip').innerHTML = `<b>${model.meta.repo}</b> · ${model.meta.branch} @ <b>${model.meta.commit}</b> · ${model.meta.files} files · ${model.meta.lines.toLocaleString()} lines · ${belts.counts.edges} belts`;
  $('#repo-chip').title = `${model.meta.subject}\nScanned ${new Date(model.meta.scannedAt).toLocaleString()}`;

  // Labels: one per machine, shown near the camera; one per zone, shown from afar.
  const labels = new Map<string, CSS2DObject>();
  for (const [id, top] of machines.tops) {
    const entity = index.byId.get(id);
    if (!entity) continue;
    const div = document.createElement('div');
    div.className = 'mlabel';
    div.style.setProperty('--c', entity.kind === 'test' ? ZONES.qa.color : ZONES[entity.zone].color);
    div.textContent = entity.file === entity.id ? entity.id.split('/').pop() ?? entity.id : entity.label;
    if (entity.lines !== undefined) div.append(Object.assign(document.createElement('small'), { textContent: `${entity.lines}` }));
    const label = new CSS2DObject(div);
    label.position.copy(top);
    label.visible = false;
    stage.scene.add(label);
    labels.set(id, label);
  }
  const zoneLabels = new Map<ZoneId, CSS2DObject>();
  for (const plot of layout.plots.values()) {
    const div = document.createElement('div');
    div.className = 'zlabel';
    div.style.setProperty('--c', ZONES[plot.zone].color);
    div.textContent = `${ZONES[plot.zone].icon} ${ZONES[plot.zone].title}`;
    const label = new CSS2DObject(div);
    label.position.set((plot.minX + plot.maxX) / 2, 16, (plot.minZ + plot.maxZ) / 2);
    stage.scene.add(label);
    zoneLabels.set(plot.zone, label);
  }

  // Camera moves.
  const fly = { from: new THREE.Vector3(), to: new THREE.Vector3(), targetFrom: new THREE.Vector3(), targetTo: new THREE.Vector3(), t: 1, seconds: 1 };
  function flyTo(target: THREE.Vector3, distance: number, direction?: THREE.Vector3, seconds = 1.1): void {
    // In walk mode the camera belongs to the walker.
    if (walker.active) return;
    const dir = direction?.clone().normalize() ?? stage.camera.position.clone().sub(stage.controls.target).normalize();
    if (!direction && dir.y < 0.35) {
      dir.y = 0.55;
      dir.normalize();
    }
    fly.from.copy(stage.camera.position);
    fly.targetFrom.copy(stage.controls.target);
    fly.targetTo.copy(target);
    fly.to.copy(target).addScaledVector(dir, distance);
    fly.t = 0;
    fly.seconds = seconds;
  }
  function home(): void {
    flyTo(new THREE.Vector3(0, 0, 8), extent * 0.72, new THREE.Vector3(0, 0.8, 0.6));
  }
  /** Walk in front of the zone the orbit camera looks at, facing into it. */
  function toggleWalk(): void {
    if (walker.active) {
      walker.exit();
      return;
    }
    fly.t = 1;
    orbit.camera.copy(stage.camera.position);
    orbit.target.copy(stage.controls.target);
    const target = stage.controls.target;
    let nearest: { zone: ZoneId; x: number; z: number } | null = null;
    let best = Infinity;
    for (const plot of layout.plots.values()) {
      const distance = Math.hypot((plot.minX + plot.maxX) / 2 - target.x, (plot.minZ + plot.maxZ) / 2 - target.z);
      if (distance < best) {
        best = distance;
        nearest = { zone: plot.zone, x: plot.hub.x + 3, z: plot.maxZ + 3 };
      }
    }
    walker.enter(new THREE.Vector3(nearest?.x ?? 0, 0, nearest?.z ?? 0), 0);
    if (nearest) log('scenario', `Walking in front of the ${ZONES[nearest.zone].title}. WASD to walk, the mouse to look, Esc to leave.`, clock.stamp);
  }
  // The crosshair names what it points at, and the HUD names the zone underfoot.
  let walkTick = 0;
  function updateWalkHud(dt: number): void {
    walkTick += dt;
    if (walkTick < 0.1) return;
    walkTick = 0;
    const picked = pickNdc(0, 0);
    if (picked?.type === 'entity') {
      const entity = index.byId.get(picked.id);
      state.hover = picked.id;
      effects.hover(machines.bounds.get(picked.id) ?? null);
      walkTarget.textContent = entity ? `${entity.kind === 'route' || entity.kind === 'job' ? entity.label : entity.id} · ${KINDS[entity.kind].machine}` : '';
    } else {
      state.hover = null;
      effects.hover(null);
      walkTarget.textContent = '';
    }
    const at = walker.position;
    const plot = [...layout.plots.values()].find((item) => at.x >= item.minX && at.x <= item.maxX && at.z >= item.minZ && at.z <= item.maxZ);
    walkZone.textContent = plot ? `${ZONES[plot.zone].icon} ${ZONES[plot.zone].title}` : '🌳 Outside';
    walkZone.style.borderLeftColor = plot ? ZONES[plot.zone].color : '#5d9a3c';
  }
  function frameSelection(selection: Selection): void {
    if (!selection) return home();
    if (selection.type === 'zone') {
      const plot = layout.plots.get(selection.zone);
      if (!plot) return;
      const size = Math.max(plot.maxX - plot.minX, plot.maxZ - plot.minZ);
      flyTo(new THREE.Vector3((plot.minX + plot.maxX) / 2, 0, (plot.minZ + plot.maxZ) / 2), size * 1.05 + 10);
      return;
    }
    const box = machines.bounds.get(selection.id);
    if (!box) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    flyTo(center, Math.max(9, size * 3.2));
  }

  function focusSet(selection: Selection): Set<string> | null {
    if (!selection) return null;
    if (selection.type === 'zone') return new Set((index.byZone.get(selection.zone) ?? []).map((entity) => entity.id));
    return new Set([selection.id]);
  }
  function applyBelts(): void {
    belts.setFilter({ mode: state.beltMode, focus: focusSet(state.selection), typeOnly: state.typeOnly });
  }

  function select(selection: Selection, focus: boolean): void {
    const changed = !sameSelection(selection, state.selection);
    state.selection = selection;
    if (selection?.type === 'entity') {
      effects.select(machines.bounds.get(selection.id) ?? null);
      effects.outlineZone(null);
    } else if (selection?.type === 'zone') {
      effects.select(null);
      const plot = layout.plots.get(selection.zone);
      effects.outlineZone(plot ?? null, ZONES[selection.zone].color);
    } else {
      effects.select(null);
      effects.outlineZone(null);
    }
    if (changed) {
      hierarchy.reveal(selection);
      inspector.show(selection);
      applyBelts();
      refreshLabels();
    }
    if (focus) frameSelection(selection);
    saveView();
  }

  // Picking.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const tooltip = $<HTMLDivElement>('#tooltip');
  function pickAt(event: PointerEvent | MouseEvent): Selection {
    const rect = stage.renderer.domElement.getBoundingClientRect();
    return pickNdc(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  }
  function pickNdc(x: number, y: number): Selection {
    pointer.set(x, y);
    raycaster.setFromCamera(pointer, stage.camera);
    const hit = raycaster.intersectObject(machines.pick, false)[0];
    if (hit && hit.instanceId !== undefined) {
      const id = machines.pickIds[hit.instanceId];
      if (id) return { type: 'entity', id };
    }
    const slab = raycaster.intersectObjects(machines.slabs, false)[0];
    if (slab) return { type: 'zone', zone: slab.object.userData.zone as ZoneId };
    return null;
  }
  let down: { x: number; y: number } | null = null;
  const canvas = stage.renderer.domElement;
  canvas.addEventListener('pointerdown', (event) => {
    down = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5 || event.button !== 0) return;
    // Walking: a click picks what the crosshair is on (the first click only locks the mouse).
    if (walker.active) {
      if (walker.locked) select(pickNdc(0, 0), false);
      return;
    }
    select(pickAt(event), false);
  });
  canvas.addEventListener('dblclick', (event) => {
    if (!walker.active) select(pickAt(event), true);
  });
  let hoverQueued: PointerEvent | null = null;
  canvas.addEventListener('pointermove', (event) => {
    hoverQueued = event;
  });
  canvas.addEventListener('pointerleave', () => {
    hoverQueued = null;
    state.hover = null;
    effects.hover(null);
    tooltip.hidden = true;
  });
  function updateHover(): void {
    if (walker.active) return;
    if (!hoverQueued) return;
    const event = hoverQueued;
    hoverQueued = null;
    if (event.buttons !== 0) return;
    const picked = pickAt(event);
    const rect = viewport.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - rect.left}px`;
    tooltip.style.top = `${event.clientY - rect.top}px`;
    if (picked?.type === 'entity') {
      const entity = index.byId.get(picked.id);
      state.hover = picked.id;
      effects.hover(machines.bounds.get(picked.id) ?? null);
      if (entity) {
        tooltip.hidden = false;
        tooltip.innerHTML = '';
        tooltip.append(entity.kind === 'route' || entity.kind === 'job' ? entity.label : entity.id, Object.assign(document.createElement('div'), { className: 'k', textContent: `${KINDS[entity.kind].machine} · ${ZONES[entity.zone].title}${entity.lines !== undefined ? ` · ${entity.lines} lines` : ''}` }));
      }
      canvas.style.cursor = 'pointer';
    } else {
      state.hover = null;
      effects.hover(null);
      if (picked?.type === 'zone') {
        tooltip.hidden = false;
        tooltip.textContent = `${ZONES[picked.zone].icon} ${ZONES[picked.zone].title}`;
      } else tooltip.hidden = true;
      canvas.style.cursor = picked ? 'pointer' : 'default';
    }
  }

  // Labels near the camera, and the selected and hovered ones.
  function refreshLabels(): void {
    const camera = stage.camera.position;
    const near: [number, CSS2DObject, string][] = [];
    for (const [id, label] of labels) {
      label.visible = false;
      if (!state.labels) continue;
      const distance = camera.distanceTo(label.position);
      if (distance < (walker.active ? 16 : 48)) near.push([distance, label, id]);
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [, label] of near.slice(0, walker.active ? 24 : 70)) label.visible = true;
    const pinned = state.selection?.type === 'entity' ? state.selection.id : null;
    for (const id of [pinned, state.hover]) {
      const label = id ? labels.get(id) : undefined;
      if (label) label.visible = true;
    }
    for (const [zone, label] of zoneLabels) {
      const plot = layout.plots.get(zone);
      if (!plot) continue;
      const center = new THREE.Vector3((plot.minX + plot.maxX) / 2, 0, (plot.minZ + plot.maxZ) / 2);
      label.visible = !walker.active && camera.distanceTo(center) > 55;
    }
  }

  // Roofs lift when you look into a zone.
  function updateRoofs(dt: number): void {
    const target = stage.controls.target;
    const distance = stage.camera.position.distanceTo(target);
    const selectedZone = state.selection?.type === 'zone' ? state.selection.zone : state.selection?.type === 'entity' ? index.byId.get(state.selection.id)?.zone : undefined;
    for (const [zone, roof] of machines.roofs) {
      const plot = layout.plots.get(zone);
      if (!plot) continue;
      const inside = target.x > plot.minX - 4 && target.x < plot.maxX + 4 && target.z > plot.minZ - 4 && target.z < plot.maxZ + 4;
      // While walking, the roofs stay on overhead (unless they are switched off).
      const auto = walker.active ? 0 : zone === selectedZone || (inside && distance < 90) ? 1 : 0;
      const goal = state.roofs === 'off' ? 1 : state.roofs === 'on' ? 0 : auto;
      roof.lift += (goal - roof.lift) * Math.min(1, dt * 3.5);
      roof.group.position.y = roof.lift * 16;
      roof.truss.opacity = 1 - roof.lift;
      roof.panel.opacity = 0.35 * (1 - roof.lift);
      roof.group.visible = roof.lift < 0.98;
    }
  }

  // Scenarios.
  const scenarioCard = $<HTMLDivElement>('#scenario-card');
  let scenarioToken = 0;
  let simDelay: { left: number; resolve: () => void }[] = [];
  const wait = (seconds: number): Promise<void> => new Promise((resolve) => simDelay.push({ left: seconds, resolve }));
  const ping = (id: string, color: string, size = 1): void => {
    const top = machines.tops.get(id);
    if (top) effects.ping(top, color, size);
  };

  async function runScenario(scenario: Scenario): Promise<void> {
    const token = ++scenarioToken;
    effects.clearPackets();
    log('scenario', `▶ Scenario: ${scenario.title}`, clock.stamp);
    let previous: string | undefined;
    const steps = scenario.steps.filter((step) => {
      if (machines.tops.has(step.at)) return true;
      log('scenario', `Skipped a step: \`${step.at}\` is not in this checkout.`, clock.stamp);
      return false;
    });
    for (const [n, step] of steps.entries()) {
      if (token !== scenarioToken) return;
      const entity = index.byId.get(step.at);
      if (!entity) continue;
      const zone = ZONES[entity.zone];
      scenarioCard.hidden = false;
      scenarioCard.innerHTML = '';
      scenarioCard.append(
        Object.assign(document.createElement('span'), { className: 'step', textContent: `${n + 1}/${steps.length}` }),
        step.say,
        Object.assign(document.createElement('span'), { className: 'where', textContent: `${zone.icon} ${zone.title} › ${entity.kind === 'route' || entity.kind === 'job' ? entity.label : entity.id}` }),
      );
      const bar = Object.assign(document.createElement('div'), { className: 'bar' });
      bar.append(Object.assign(document.createElement('i'), { style: `width:${((n + 1) / steps.length) * 100}%` }));
      scenarioCard.append(bar);
      if (state.follow) {
        const box = machines.bounds.get(step.at);
        if (box) flyTo(box.getCenter(new THREE.Vector3()), 26, undefined, 1.2);
      }
      if (previous) {
        const from = machines.tops.get(previous);
        const to = machines.tops.get(step.at);
        const route = belts.routeBetween(previous, step.at) ?? pipes.routeBetween(previous, step.at);
        const points = route ?? (from && to ? effects.arc(from, to) : []);
        let length = 0;
        for (let p = 1; p < points.length; p += 1) length += points[p - 1]?.distanceTo(points[p] ?? new THREE.Vector3()) ?? 0;
        await effects.packet(points, '#ffd23f', Math.min(3.5, Math.max(0.7, length / 26)));
        if (token !== scenarioToken) return;
      }
      activity.set(step.at, 2);
      ping(step.at, '#ffd23f', 1.2);
      deliverFor(scenario.id, step.at);
      if (state.follow) select({ type: 'entity', id: step.at }, false);
      log('scenario', `${n + 1}. ${step.say}  \`${entity.kind === 'route' || entity.kind === 'job' ? entity.label : entity.id}\``, clock.stamp, { type: 'entity', id: step.at });
      await wait(1.5);
      previous = step.at;
    }
    if (token !== scenarioToken) return;
    log('scenario', `■ Done: ${scenario.title}`, clock.stamp);
    await wait(2.5);
    if (token === scenarioToken) scenarioCard.hidden = true;
  }
  // Some steps send something out of the factory, each in its own way.
  function deliverFor(scenario: string, at: string): void {
    if (scenario === 'push-main' && at === 'stage:site' && deliveries.train('prod')) log('scenario', '🚂 The deploy train leaves for the server with the build, api and site images (prod).', clock.stamp);
    if (scenario === 'pr-preview' && at === 'stage:build' && deliveries.train('preview')) log('scenario', '🚂 A preview train leaves with the images for pr-<n>.', clock.stamp);
    if (at === 'job:ios.yml#app' && deliveries.ship('ios')) log('scenario', '🚢 The iOS build sails for TestFlight.', clock.stamp);
    if (at === 'job:android.yml#bundle' && deliveries.ship('android')) log('scenario', '🚢 The Android bundle sails for Google Play.', clock.stamp);
    if (at === 'src/ai-worker.ts') deliveries.message();
    if (at === 'src/nearby/peer.ts') deliveries.radio(8);
  }
  function stopScenario(): void {
    scenarioToken += 1;
    effects.clearPackets();
    for (const delay of simDelay) delay.resolve();
    simDelay = [];
    scenarioCard.hidden = true;
  }

  // Cron: a workflow wakes up and runs its jobs in `needs` order.
  async function runWorkflow(workflow: Entity, why: string): Promise<void> {
    log('schedule', `⏰ ${why}: \`${workflow.id}\``, clock.stamp, { type: 'entity', id: workflow.id });
    activity.set(workflow.id, 2.5);
    ping(workflow.id, '#00c2ff', 1.4);
    const jobs = model.entities.filter((entity) => entity.kind === 'job' && entity.file === workflow.id);
    const done = new Set<string>();
    let wave = jobs.filter((job) => !Array.isArray(job.data?.needs));
    let from = workflow.id;
    while (wave.length) {
      await Promise.all(
        wave.map(async (job) => {
          const route = belts.routeBetween(from, job.id) ?? effects.arc(machines.tops.get(from) ?? new THREE.Vector3(), machines.tops.get(job.id) ?? new THREE.Vector3(), 3);
          await effects.packet(route, '#00c2ff', 1);
          activity.set(job.id, 3);
          ping(job.id, '#00c2ff');
          const steps = Array.isArray(job.data?.steps) ? job.data.steps.length : 0;
          log('schedule', `  job \`${job.label}\` runs on ${String(job.data?.runsOn ?? job.data?.uses ?? 'a runner')}: ${steps} steps`, clock.stamp, { type: 'entity', id: job.id });
          await wait(1.2);
          done.add(job.id.split('#')[1] ?? '');
        }),
      );
      from = wave[0]?.id ?? from;
      wave = jobs.filter((job) => !done.has(job.id.split('#')[1] ?? '') && Array.isArray(job.data?.needs) && (job.data.needs as string[]).every((need) => done.has(need)));
    }
  }

  // A zone's steam engines run while one of its jobs is busy.
  const zoneBusy = (zone: ZoneId): boolean => {
    for (const id of activity.keys()) {
      const entity = index.byId.get(id);
      if (entity?.zone === zone && (entity.kind === 'job' || entity.kind === 'workflow')) return true;
    }
    return false;
  };

  // API traffic: players' requests arrive at the docks through the site container's Caddy.
  let trafficIn = 1;
  let truckIn = 6;
  // How hard requests drive the water wheel: up with each request, slowly down again.
  let apiFlow = 0;
  const gateway = 'service:compose.yml#site';
  function traffic(dt: number): void {
    trafficIn -= dt * (0.35 + clock.daylight * 1.1);
    if (trafficIn > 0) return;
    trafficIn = 0.6 + Math.random() * 0.9;
    const route = pickRoute(routes);
    const start = machines.tops.get(gateway);
    const end = route ? machines.tops.get(route.id) : undefined;
    if (!route || !start || !end) return;
    const method = String(route.data?.method ?? 'GET');
    const color = METHOD_COLORS[method] ?? '#ffffff';
    // A request the client code makes rides its pneumatic tube; the rest (docs, sign-in redirects,
    // admin calls) come straight in through the gateway.
    const arrival = pipes.sendCapsule(route.id, color) ?? effects.packet(effects.arc(start, end, 10), color, 2.2);
    void arrival.then(() => {
      apiFlow = Math.min(1, apiFlow + 0.2);
      activity.set(route.id, 1);
      ping(route.id, color, 0.7);
      log('traffic', `${statusFor(route)} ${method} \`${samplePath(String(route.data?.path ?? ''))}\``, clock.stamp, { type: 'entity', id: route.id });
    });
  }

  // Toolbar.
  const scenarioSelect = $<HTMLSelectElement>('#scenario');
  for (const scenario of SCENARIOS) scenarioSelect.append(new Option(scenario.title, scenario.id));
  const run = (): void => {
    const scenario = SCENARIOS.find((item) => item.id === scenarioSelect.value);
    if (!scenario) return;
    stopScenario();
    if (!state.playing) setPlaying(true);
    void runScenario(scenario);
  };
  $('#run').addEventListener('click', run);
  $('#stop').addEventListener('click', stopScenario);
  function setPlaying(playing: boolean): void {
    state.playing = playing;
    $('#play').classList.toggle('active', playing);
    $('#pause').classList.toggle('active', !playing);
    document.body.classList.toggle('playing', playing);
  }
  setPlaying(true);
  $('#play').addEventListener('click', () => setPlaying(true));
  $('#pause').addEventListener('click', () => setPlaying(false));
  let stepRequest = 0;
  $('#step').addEventListener('click', () => {
    setPlaying(false);
    stepRequest += 1;
  });
  $<HTMLSelectElement>('#speed').addEventListener('change', (event) => {
    state.speed = Number((event.target as HTMLSelectElement).value);
  });
  $('#rescan').addEventListener('click', () => {
    saveView();
    location.reload();
  });
  const help = $<HTMLDivElement>('#help');
  const showHelp = (on: boolean): void => {
    help.hidden = !on;
    try {
      localStorage.setItem('tick3d-factory-help-seen', '1');
    } catch {
      // Private mode: the help shows again next time.
    }
  };
  $('#help-button').addEventListener('click', () => showHelp(true));
  $('#help-close').addEventListener('click', () => showHelp(false));
  help.addEventListener('click', (event) => {
    if (event.target === help) showHelp(false);
  });

  for (const tool of document.querySelectorAll<HTMLButtonElement>('.tool')) {
    tool.addEventListener('click', () => {
      if (tool.dataset.tool === 'home') home();
      if (tool.dataset.tool === 'frame') frameSelection(state.selection);
      if (tool.dataset.tool === 'top') topView();
      if (tool.dataset.tool === 'walk') toggleWalk();
    });
  }
  function topView(): void {
    flyTo(stage.controls.target.clone(), Math.max(60, stage.camera.position.distanceTo(stage.controls.target)), new THREE.Vector3(0, 1, 0.001));
  }

  // Scene bar.
  const bind = <T extends HTMLInputElement | HTMLSelectElement>(selector: string, apply: (input: T) => void): void => {
    const input = $<T>(selector);
    input.addEventListener('change', () => apply(input));
  };
  bind<HTMLSelectElement>('#shading', (input) => {
    stage.scene.traverse((object) => {
      const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (material && 'wireframe' in material && !(object instanceof THREE.Sprite)) material.wireframe = input.value === 'wire';
    });
  });
  bind<HTMLInputElement>('#opt-labels', (input) => {
    state.labels = input.checked;
    refreshLabels();
  });
  bind<HTMLSelectElement>('#opt-belts', (input) => {
    state.beltMode = input.value as BeltMode;
    applyBelts();
  });
  bind<HTMLInputElement>('#opt-types', (input) => {
    state.typeOnly = input.checked;
    applyBelts();
  });
  bind<HTMLSelectElement>('#opt-roofs', (input) => {
    state.roofs = input.value as typeof state.roofs;
  });
  bind<HTMLSelectElement>('#opt-light', (input) => {
    state.light = input.value as typeof state.light;
  });
  bind<HTMLInputElement>('#opt-follow', (input) => {
    state.follow = input.checked;
  });
  bind<HTMLInputElement>('#opt-gizmos', (input) => effects.setGizmos(input.checked));

  // Keyboard.
  window.addEventListener('keydown', (event) => {
    // The walker already used this key (Esc, Space, the arrows).
    if (event.defaultPrevented) return;
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      hierarchy.focusSearch();
      return;
    }
    if (typing) {
      if (event.key === 'Escape') (event.target as HTMLElement).blur();
      return;
    }
    if (walker.active && 'fFhHtT'.includes(event.key)) return;
    switch (event.key) {
      case 'p':
      case 'P':
        toggleWalk();
        break;
      case 'e':
      case 'E':
        if (walker.active) select(pickNdc(0, 0), false);
        break;
      case ' ':
        event.preventDefault();
        setPlaying(!state.playing);
        break;
      case '.':
        setPlaying(false);
        stepRequest += 1;
        break;
      case 'f':
      case 'F':
        frameSelection(state.selection);
        break;
      case 'h':
      case 'H':
        home();
        break;
      case 't':
      case 'T':
        topView();
        break;
      case 'r':
      case 'R':
        run();
        break;
      case 'l':
      case 'L': {
        const input = $<HTMLInputElement>('#opt-labels');
        input.checked = !input.checked;
        input.dispatchEvent(new Event('change'));
        break;
      }
      case 'b':
      case 'B': {
        const input = $<HTMLSelectElement>('#opt-belts');
        input.selectedIndex = (input.selectedIndex + 1) % input.options.length;
        input.dispatchEvent(new Event('change'));
        break;
      }
      case 'Escape':
        if (!help.hidden) showHelp(false);
        else select(null, false);
        break;
      case '?':
        showHelp(Boolean(help.hidden));
        break;
    }
  });

  // Splitters resize the panels.
  for (const splitter of document.querySelectorAll<HTMLElement>('.splitter')) {
    splitter.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const which = splitter.dataset.split;
      const root = document.documentElement;
      const move = (e: PointerEvent): void => {
        if (which === 'left') root.style.setProperty('--left', `${Math.min(600, Math.max(180, e.clientX))}px`);
        if (which === 'right') root.style.setProperty('--right', `${Math.min(700, Math.max(240, window.innerWidth - e.clientX))}px`);
        if (which === 'bottom') root.style.setProperty('--bottom', `${Math.min(window.innerHeight - 200, Math.max(60, window.innerHeight - e.clientY))}px`);
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  // The axis gizmo looks along an axis.
  const viewName = $('#view-name');
  const axisGizmo = createAxisGizmo($<HTMLCanvasElement>('#axis-gizmo'), stage.camera, (dir) => {
    const distance = stage.camera.position.distanceTo(stage.controls.target);
    if (Math.abs(dir.y) > 0.9) dir.set(0, Math.sign(dir.y) || 1, 0.001);
    if (dir.y < 0) dir.y = 0.05;
    flyTo(stage.controls.target.clone(), distance, dir);
  });

  // Saved view: survives a Rescan.
  function saveView(): void {
    try {
      sessionStorage.setItem(
        SAVED,
        JSON.stringify({ camera: (walker.active ? orbit.camera : stage.camera.position).toArray(), target: stage.controls.target.toArray(), selection: state.selection }),
      );
    } catch {
      // No storage: nothing to restore.
    }
  }
  let restored = false;
  try {
    const saved = JSON.parse(sessionStorage.getItem(SAVED) ?? 'null') as { camera: number[]; target: number[]; selection: Selection } | null;
    if (saved) {
      stage.camera.position.fromArray(saved.camera);
      stage.controls.target.fromArray(saved.target);
      const selection = saved.selection;
      if (selection?.type === 'entity' ? index.byId.has(selection.id) : selection?.type === 'zone') select(selection, false);
      restored = true;
    }
  } catch {
    // Ignore a broken saved view.
  }
  if (!restored) {
    stage.camera.position.set(0, extent * 1.6, extent * 1.6);
    home();
    inspector.show(null);
  }
  stage.controls.addEventListener('end', saveView);
  window.addEventListener('beforeunload', saveView);

  log('scenario', `Scanned \`${model.meta.repo}\` @ ${model.meta.branch} (${model.meta.commit}): ${model.meta.files} files, ${model.meta.lines.toLocaleString()} lines, ${belts.counts.edges} belts, ${routes.length} docks, ${crons.length} cron schedules.`, clock.stamp);
  log('scenario', 'Pick a scenario at the top right and press Run (or R) to watch a real path through the code.', clock.stamp);
  applyBelts();
  refreshLabels();
  $('#loading').remove();
  try {
    if (!localStorage.getItem('tick3d-factory-help-seen')) showHelp(true);
  } catch {
    showHelp(true);
  }

  // The loop.
  let previous = performance.now();
  let frames = 0;
  let fpsTime = 0;
  let labelTick = 0;
  const clockDay = $('#clock-day');
  const clockTime = $('#clock-time');
  const clockNext = $('#clock-next');
  const fps = $('#fps');
  let shownLight = state.light === 'day' ? 1 : state.light === 'night' ? 0 : clock.daylight;

  // A hidden window gets no animation frames; a timer keeps the simulation going at a low rate.
  let lastFrame = 0;
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame((time) => {
      scheduled = false;
      frame(time);
    });
  };
  setInterval(() => {
    if (performance.now() - lastFrame > 250) frame(performance.now());
  }, 120);

  function frame(timestamp: number): void {
    lastFrame = performance.now();
    schedule();
    const real = Math.min(0.1, Math.max(0, (timestamp - previous) / 1000));
    previous = timestamp;
    let dt = state.playing ? real * state.speed : 0;
    if (stepRequest > 0) {
      dt += 1 * state.speed;
      stepRequest -= 1;
    }

    if (dt > 0) {
      stage.time.value += dt;
      for (const cron of clock.advance(dt, crons)) void runWorkflow(cron.workflow, `cron ${cron.expression}`);
      traffic(dt);
      for (const [id, level] of activity) {
        const next = level - dt * 0.7;
        if (next <= 0) activity.delete(id);
        else activity.set(id, next);
      }
      for (let n = simDelay.length - 1; n >= 0; n -= 1) {
        const delay = simDelay[n];
        if (!delay) continue;
        delay.left -= dt;
        if (delay.left <= 0) {
          simDelay.splice(n, 1);
          delay.resolve();
        }
      }
      belts.update(dt);
      pipes.update(dt);
      apiFlow = Math.max(0, apiFlow - dt * 0.15);
      landscape.update(dt, apiFlow);
      power.update(dt, { players: clock.daylight, water: apiFlow, busy: zoneBusy });
      deliveries.update(dt, clock.daylight);
      truckIn -= dt;
      if (truckIn <= 0) {
        truckIn = 25 + Math.random() * 20;
        const dep = deliveries.truck();
        if (dep) log('traffic', `🚚 A truck from the npm registry brings \`${dep.label}@${String(dep.data?.version ?? '')}\` to the Raw Materials Dock.`, clock.stamp, { type: 'entity', id: dep.id });
      }
    }
    const goalLight = state.light === 'day' ? 1 : state.light === 'night' ? 0 : clock.daylight;
    shownLight += (goalLight - shownLight) * Math.min(1, real * 2);
    stage.setDaylight(shownLight);
    machines.update(dt, stage.time.value, activity, 1 - shownLight);
    effects.update(dt, stage.camera);

    if (walker.active) {
      walker.update(real);
      updateWalkHud(real);
    } else {
      if (fly.t < 1) {
        fly.t = Math.min(1, fly.t + real / fly.seconds);
        const ease = 1 - Math.pow(1 - fly.t, 3);
        stage.camera.position.lerpVectors(fly.from, fly.to, ease);
        stage.controls.target.lerpVectors(fly.targetFrom, fly.targetTo, ease);
        if (fly.t >= 1) saveView();
      }
      stage.controls.update(real);
    }
    updateRoofs(real);
    updateHover();
    labelTick += real;
    if (labelTick > 0.2) {
      labelTick = 0;
      refreshLabels();
      clockDay.textContent = clock.day;
      clockTime.textContent = clock.time;
      const next = clock.next(crons);
      clockNext.textContent = next ? `next: ${String(next.cron.workflow.data?.name ?? next.cron.workflow.label)} in ${Math.floor(next.inMinutes / 60)}h ${Math.floor(next.inMinutes % 60)}m` : '';
      const polar = stage.controls.getPolarAngle();
      viewName.textContent = walker.active ? '◤ Walk' : polar < 0.05 ? '◤ Top' : '◤ Persp';
    }
    axisGizmo.draw();
    stage.render();

    frames += 1;
    fpsTime += real;
    if (fpsTime > 0.5) {
      fps.textContent = `${Math.round(frames / fpsTime)} fps · ${stage.renderer.info.render.calls} draws`;
      frames = 0;
      fpsTime = 0;
    }
  }
  schedule();

  // Exposed for the console of the browser.
  // snap(): render now and save the frame through the dev server (works even in a hidden window).
  const snap = async (name = 'frame'): Promise<string> => {
    stage.render();
    const data = stage.renderer.domElement.toDataURL('image/png');
    await fetch(`/__snapshot?name=${encodeURIComponent(name)}`, { method: 'POST', body: data });
    return name;
  };
  const view = (x: number, y: number, z: number, tx: number, ty: number, tz: number): void => {
    fly.t = 1;
    stage.camera.position.set(x, y, z);
    stage.controls.target.set(tx, ty, tz);
    stage.controls.update();
  };
  Object.assign(window, { factory: { model, layout, index, select, runScenario, ZONE_ORDER, snap, view, stage, frameSelection, walker, toggleWalk, activity, power, pipes, landscape, deliveries } });
}

start().catch((error: unknown) => {
  const text = document.querySelector('#loading-text');
  if (text) text.textContent = `The factory could not start: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
