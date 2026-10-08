// The three.js scene of the spot: the dotted page, the tower, the pieces, the lines, the beam, the confetti and
// the text. `render` draws one frame, and everything in it is a function of the frame number.
import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NoColorSpace,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  Vector3,
  WebGLRenderTarget,
  type BufferGeometry,
  type WebGLRenderer,
} from 'three';
import { interpolate } from 'remotion';
import { CELL_COUNT, LINES, SIZE, toCoords } from '../../src/game.ts';
import { seededRandom } from '../../src/practice/practice.ts';
import { SIXTEENTH } from '../../src/song.ts';
import { winVoices } from '../../src/sound.ts';
import { cameraAt } from './camera.ts';
import { PX, drawHud } from './hud.ts';
import { CELL, LAYER_GAP, OUTLINE, PIECE_HEIGHT, TILE_HEIGHT, cellBase, cellCenter } from './layout.ts';
import { oShape, xShape } from './pieces.ts';
import { type Theme, type ThemeId, type Token, readTheme, readXPolygon } from './themes.ts';
import { BEATS, barAt, barBefore, eventOf, eventsOf, frameOf, since } from './timeline.ts';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
// A cell closer than NEAR to the camera is not drawn, and one closer than NEAR_FADE fades, so the ride along
// the beam never clips a slab.
const NEAR = 1.5;
const NEAR_FADE = 3.2;

// The pulse of a note: up to 1 at once, back to 0 over 2 sixteenths. 0 before the note.
function pulse(t: number): number {
  if (t < 0 || t >= 2.25) return 0;
  return t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 2;
}

// Every material takes its color from one theme token, so a theme change repaints the whole frame.
type Painted = { material: MeshBasicMaterial; token: Token };

const SCREEN_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

// The page: `--page` with the `--dot` grid of 22 px (the body background of src/style.css).
const PAGE_FRAGMENT = `
uniform vec3 page; uniform vec4 dotColor; uniform float grid; uniform float inner; uniform float outer;
void main() {
  float d = length(mod(gl_FragCoord.xy, grid) - grid * 0.5);
  float a = dotColor.a * (1.0 - smoothstep(inner, outer, d));
  gl_FragColor = vec4(mix(page, dotColor.rgb, a), 1.0);
}`;

// The theme wipe: the new theme from the bottom left corner up to `front`, a `--line` band on the edge.
const WIPE_FRAGMENT = `
uniform sampler2D before; uniform sampler2D after; uniform vec3 band; uniform float front; uniform float bandWidth;
varying vec2 vUv;
void main() {
  float s = (gl_FragCoord.x + gl_FragCoord.y) * 0.70710678;
  vec3 color = s < front - bandWidth ? texture2D(after, vUv).rgb : (s < front ? band : texture2D(before, vUv).rgb);
  gl_FragColor = vec4(color, 1.0);
}`;

// A cylinder of length 1 along y, centred on the origin: lines and the beam scale it.
const unitCylinder = (radius: number) => new CylinderGeometry(radius, radius, 1, 12, 1, true);

// Places a unit cylinder from `a` to `b`.
function stretch(mesh: Object3D, a: Vector3, b: Vector3, length = 1): void {
  const direction = b.clone().sub(a);
  mesh.position.copy(a).addScaledVector(direction, length / 2);
  mesh.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.clone().normalize()));
  mesh.scale.set(1, Math.max(direction.length() * length, 1e-4), 1);
}

export type World = { render(gl: WebGLRenderer, frame: number): void; dispose(): void };

export function createWorld(width: number, height: number): World {
  const themes = new Map<ThemeId, Theme>();
  const themeOf = (id: ThemeId): Theme => {
    let theme = themes.get(id);
    if (theme === undefined) themes.set(id, (theme = readTheme(id)));
    return theme;
  };

  const painted: Painted[] = [];
  const paint = (token: Token, options: ConstructorParameters<typeof MeshBasicMaterial>[0] = {}): Painted => {
    const entry = { material: new MeshBasicMaterial(options), token };
    painted.push(entry);
    return entry;
  };

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, width / height, 0.02, 200);
  const screen = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---- The page ----
  const page = new ShaderMaterial({
    uniforms: { page: { value: new Color() }, dotColor: { value: [0, 0, 0, 0] }, grid: { value: 22 * PX }, inner: { value: 1.2 * PX }, outer: { value: 1.6 * PX } },
    vertexShader: SCREEN_VERTEX,
    fragmentShader: PAGE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const pageScene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), page));

  // ---- The tower: four layers of 16 tiles. Each tile has a `--line` outline and a hard `--shadow` below it. ----
  const tileGeometry = new BoxGeometry(CELL, TILE_HEIGHT, CELL);
  // The hard shadow: a flat plane under the tile, offset to the right and the front. Its face points up, so
  // it shows as the offset strips from above and is culled from below, where the slab stays its own colour.
  const tileShadowGeometry = new PlaneGeometry(CELL + OUTLINE, CELL + OUTLINE).rotateX(-Math.PI / 2);
  const tileOutline = new BoxGeometry(CELL + 2 * OUTLINE, TILE_HEIGHT + 2 * OUTLINE, CELL + 2 * OUTLINE);
  const layers = Array.from({ length: SIZE }, (_, layer) => {
    const group = new Group();
    group.position.y = layer * LAYER_GAP;
    scene.add(group);
    return group;
  });
  const cells = Array.from({ length: CELL_COUNT }, (_, cell) => {
    const group = new Group();
    const base = cellBase(cell);
    group.position.set(base.x, 0, base.z);
    // Own materials per cell: a cell near the camera fades out, so a ride through the tower never clips a slab.
    const tile = paint('slab', { transparent: true });
    const line = paint('line', { side: BackSide, transparent: true });
    const shade = paint('shadow', { transparent: true });
    const shadow = new Mesh(tileShadowGeometry, shade.material);
    shadow.position.set(0.07, -TILE_HEIGHT / 2 - OUTLINE - 0.002, 0.07);
    group.add(new Mesh(tileGeometry, tile.material), new Mesh(tileOutline, line.material), shadow);
    layers[toCoords(cell).layer]?.add(group);
    return { group, tile, materials: [tile.material, line.material, shade.material], near: 1 };
  });

  // The shockwave of a layer slam: a thick square `--line` frame that grows, holds, then fades.
  const frameShape = new Shape().moveTo(-1, -1).lineTo(1, -1).lineTo(1, 1).lineTo(-1, 1).lineTo(-1, -1);
  frameShape.holes.push(new Shape().moveTo(-0.9, -0.9).lineTo(-0.9, 0.9).lineTo(0.9, 0.9).lineTo(0.9, -0.9).lineTo(-0.9, -0.9));
  const frameGeometry = new ShapeGeometry(frameShape).rotateX(-Math.PI / 2);
  const shockwaves = layers.map((layer) => {
    const material = paint('line', { transparent: true, side: DoubleSide, depthWrite: false });
    const mesh = new Mesh(frameGeometry, material.material);
    layer.add(mesh);
    return { mesh, material };
  });

  // ---- The pieces: an extruded X or O with a `--line` outline and a flat `--shadow` on the tile ----
  const corners = readXPolygon();
  const extrude = (shape: Shape, depth: number, lift: number): BufferGeometry =>
    new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 40 }).translate(0, 0, lift).rotateX(-Math.PI / 2);
  const shapes = {
    X: { body: extrude(xShape(corners), PIECE_HEIGHT, 0), outline: extrude(xShape(corners, OUTLINE), PIECE_HEIGHT + 2 * OUTLINE, -OUTLINE), flat: new ShapeGeometry(xShape(corners)).rotateX(-Math.PI / 2) },
    O: { body: extrude(oShape(), PIECE_HEIGHT, 0), outline: extrude(oShape(OUTLINE), PIECE_HEIGHT + 2 * OUTLINE, -OUTLINE), flat: new ShapeGeometry(oShape(), 40).rotateX(-Math.PI / 2) },
  };
  const pieces = BEATS.moves.map((move) => {
    const shape = shapes[move.player];
    const group = new Group();
    const materials = [paint(move.player === 'X' ? 'x' : 'o', { transparent: true }), paint('line', { side: BackSide, transparent: true }), paint('shadow', { transparent: true })];
    const [body, outline, shadow] = materials.map((entry) => entry.material);
    if (body === undefined || outline === undefined || shadow === undefined) throw new Error('a piece needs 3 materials');
    const flat = new Mesh(shape.flat, shadow);
    flat.position.set(0.07, 0.003, 0.07);
    const lift = new Group().add(new Mesh(shape.body, body), new Mesh(shape.outline, outline));
    group.add(flat, lift);
    group.position.y = TILE_HEIGHT / 2;
    const cell = cells[move.cell];
    if (cell === undefined) throw new RangeError(`no cell ${move.cell}`);
    cell.group.add(group);
    return { move, group, lift, materials };
  });

  // ---- The 76 lines, as thin beams ----
  const ghostLines = BEATS.bars.flatMap((bar) => bar.events).find((event) => event.kind === 'ghost-lines');
  const ghostMaterial = paint('line', { transparent: true, depthWrite: false });
  const ghostGeometry = unitCylinder(0.028);
  const ghosts = LINES.map((line, index) => {
    const mesh = new Mesh(ghostGeometry, ghostMaterial.material);
    const a = cellCenter(line[0]);
    const d = cellCenter(line[3]);
    const reach = d.clone().sub(a).normalize().multiplyScalar(0.5);
    scene.add(mesh);
    return { mesh, from: a.sub(reach), to: d.add(reach), index };
  });

  // ---- The winning beam: a `--win` core with a `--line` outline and two soft halos ----
  const beam = eventOf('beam');
  const jingle = eventOf('win-jingle');
  const beamFrom = cellCenter(beam.line[0]);
  const beamTo = cellCenter(beam.line[3]);
  // The beam ends at the centres of the two corner cells, with a short cap past each.
  const beamReach = beamTo.clone().sub(beamFrom).normalize().multiplyScalar(0.3);
  beamFrom.sub(beamReach);
  beamTo.add(beamReach);
  // The beam is light: it shines through the tiles, so it draws over the tower, the widest halo first.
  const beamParts = [
    new Mesh(unitCylinder(0.45), paint('win', { transparent: true, opacity: 0.14, depthTest: false, depthWrite: false }).material),
    new Mesh(unitCylinder(0.24), paint('win', { transparent: true, opacity: 0.35, depthTest: false, depthWrite: false }).material),
    new Mesh(unitCylinder(0.1 + OUTLINE), paint('line', { side: BackSide, transparent: true, depthTest: false, depthWrite: false }).material),
    new Mesh(unitCylinder(0.1), paint('win', { transparent: true, depthTest: false, depthWrite: false }).material),
  ];
  beamParts.forEach((part, order) => {
    part.renderOrder = 10 + order;
    scene.add(part);
  });

  // ---- Confetti from the end of the winning line, in `--x`, `--o`, `--win` and `--slab` ----
  const confetti = eventOf('confetti');
  const random = seededRandom(BEATS.game.seed);
  const CONFETTI_PER_COLOR = 40;
  const confettiGeometry = new PlaneGeometry(0.22, 0.14);
  const bursts = (['x', 'o', 'win', 'slab'] as const).map((token) => {
    const mesh = new InstancedMesh(confettiGeometry, paint(token, { side: DoubleSide }).material, CONFETTI_PER_COLOR);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const bits = Array.from({ length: CONFETTI_PER_COLOR }, () => {
      const angle = random() * Math.PI * 2;
      const rise = 0.2 + random() * 0.9;
      const speed = 3 + random() * 6;
      return {
        velocity: new Vector3(Math.cos(angle) * (1 - rise * 0.5), rise, Math.sin(angle) * (1 - rise * 0.5)).multiplyScalar(speed),
        axis: new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize(),
        spin: 6 + random() * 14,
      };
    });
    return { mesh, bits };
  });
  const confettiFrom = cellCenter(beam.line[3]);

  // ---- The text: a canvas texture on a screen quad ----
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d') ?? (() => {
    throw new Error('no 2D canvas for the text');
  })();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = NoColorSpace;
  const hudScene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
    uniforms: { map: { value: texture } },
    vertexShader: SCREEN_VERTEX,
    fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }',
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })));

  // ---- The theme wipe ----
  const targets = [new WebGLRenderTarget(width, height, { samples: 4 }), new WebGLRenderTarget(width, height, { samples: 4 })] as const;
  const wipe = new ShaderMaterial({
    uniforms: { before: { value: targets[0].texture }, after: { value: targets[1].texture }, band: { value: new Color() }, front: { value: 0 }, bandWidth: { value: 3 * PX } },
    vertexShader: SCREEN_VERTEX,
    fragmentShader: WIPE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const wipeScene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), wipe));

  // ---- One frame ----
  function update(frame: number): void {
    // The camera first: the cells near it fade, and the pieces on them fade with them.
    const shot = cameraAt(frame, barAt(frame));
    camera.position.copy(shot.position);
    camera.up.copy(shot.up);
    camera.lookAt(shot.target);
    const aspect = width / height;
    const square = (shot.fov * Math.PI) / 180;
    camera.fov = aspect >= 1 ? shot.fov : (2 * Math.atan(Math.tan(square / 2) / aspect) * 180) / Math.PI;
    camera.aspect = aspect;
    camera.zoom = shot.zoom;
    camera.setViewOffset(width, height, 0, (shot.lift * Math.min(width, height)) / 2, width, height);
    camera.updateProjectionMatrix();
    for (const cell of cells) {
      cell.near = interpolate(cell.group.getWorldPosition(new Vector3()).distanceTo(camera.position), [NEAR, NEAR_FADE], [0, 1], clamp);
      cell.group.visible = cell.near > 0;
      for (const material of cell.materials) {
        material.opacity = cell.near;
        material.depthWrite = cell.near > 0.99;
      }
    }

    // Layers: the first slam drops a layer in from above the frame, a later one pulses it in place.
    layers.forEach((layer, index) => {
      const slams = eventsOf('layer-slam').filter((event) => event.layer === index);
      const [drop, ...pulses] = slams;
      let y = index * LAYER_GAP;
      let squash = 0;
      let bump = 0;
      layer.visible = true;
      if (drop !== undefined) {
        const t = since(frame, drop.at);
        if (t < -1.5) layer.visible = false;
        else if (t < 0) y += 18 * (t / 1.5) ** 2;
        else squash = 0.6 * Math.exp(-1.8 * t) * Math.cos(3.4 * t);
      }
      for (const event of pulses) bump = Math.max(bump, pulse(since(frame, event.at)));
      layer.position.y = y;
      layer.scale.set(1 + squash * 0.3 + bump * 0.12, Math.max(0.2, 1 - squash + bump * 0.3), 1 + squash * 0.3 + bump * 0.12);
      // The ring rings only the drop of bar 1. A later pulse bumps the layer without it.
      const wave = shockwaves[index];
      if (wave !== undefined) {
        const t = drop === undefined ? Infinity : since(frame, drop.at);
        wave.mesh.visible = t < 3.5;
        const grow = 2.8 + t * 0.7;
        wave.mesh.scale.set(grow, 1, grow);
        wave.material.material.opacity = interpolate(t, [1, 3.5], [1, 0], clamp);
      }
    });

    // Tiles: `--slab`, the blinking threats, and the lit cells of the winning line.
    for (const { tile } of cells) tile.token = 'slab';
    for (const threat of eventsOf('threats')) {
      for (const cell of threat.cells) {
        const taken = BEATS.moves.find((move) => move.cell === cell && move.at >= threat.at);
        if (frame < frameOf(threat.at) || (taken !== undefined && frame >= frameOf(taken.at))) continue;
        // The blink of `.cell.win`: 0.9 s, half `--win` and half `--surface`, here on the grid (8 sixteenths).
        const entry = cells[cell];
        if (entry !== undefined) entry.tile.token = Math.floor(since(frame, threat.at) / 4) % 2 === 0 ? 'win' : 'surface';
      }
    }
    beam.line.forEach((cell, k) => {
      const entry = cells[cell];
      if (entry !== undefined && since(frame, beam.at + k) >= 0) entry.tile.token = 'win';
    });
    // A threat pulse swells the blinking tiles with their preview strike.
    for (const { group } of cells) group.scale.setScalar(1);
    for (const event of eventsOf('threat-pulse')) {
      const swell = 1 + 0.18 * pulse(since(frame, event.at));
      for (const cell of event.cells) cells[cell]?.group.scale.setScalar(swell);
    }

    // Pieces: a drop over 1 sixteenth onto the note, a pulse on every note of the piece, then the finished board.
    const replay = eventOf('replay');
    for (const { move, group, lift, materials } of pieces) {
      const t = since(frame, move.at);
      group.visible = t >= -1;
      lift.position.y = t < 0 ? 1.8 * t * t : 0;
      const lineIndex = beam.line.indexOf(move.cell);
      const notes = [move.at, replay.at + move.move, ...(lineIndex >= 0 ? [beam.at + lineIndex] : [])];
      const strength = Math.max(...notes.map((at) => pulse(since(frame, at))));
      const grow = 1 + 0.25 * strength;
      lift.scale.set(grow, grow, grow);
      // `.board.finished`: the pieces off the winning line fade to 35 %. A note lights a piece again.
      const faded = lineIndex >= 0 ? 1 : interpolate(since(frame, beam.at), [0, 4], [1, 0.35], clamp);
      const opacity = (faded + (1 - faded) * strength) * (cells[move.cell]?.near ?? 1);
      for (const entry of materials) {
        entry.material.opacity = opacity;
        entry.material.depthWrite = opacity > 0.99;
      }
    }

    // The 76 lines shoot out from their first cell, then fade until `until`.
    for (const ghost of ghosts) {
      const t = ghostLines === undefined ? -1 : since(frame, ghostLines.at);
      const visible = ghostLines !== undefined && t >= 0 && frame < frameOf(ghostLines.until);
      ghost.mesh.visible = visible;
      if (visible) stretch(ghost.mesh, ghost.from, ghost.to, interpolate(t - (ghost.index % 8) * 0.06, [0, 1], [0, 1], clamp));
    }
    if (ghostLines !== undefined) ghostMaterial.material.opacity = interpolate(since(frame, ghostLines.at), [0, ghostLines.until - ghostLines.at], [0.95, 0.3], clamp);

    // The beam joins the 4 lit cells on the sixteenth after the last one lights. It throbs on each note of the
    // win jingle, then on every beat.
    const fire = since(frame, beam.at + beam.line.length - 1);
    const jingleHits = winVoices(1).map((voice) => jingle.at + (voice.at ?? 0));
    const lastHit = jingleHits.at(-1) ?? jingle.at;
    const hit = frame < frameOf(lastHit) ? Math.max(...jingleHits.map((at) => pulse(since(frame, at)))) : pulse(since(frame, lastHit) % 4);
    for (const part of beamParts) {
      part.visible = fire >= 0;
      if (fire < 0) continue;
      stretch(part, beamFrom, beamTo, interpolate(fire, [0, 1], [0, 1], clamp));
      const throb = 1 + 0.25 * hit;
      part.scale.x = throb;
      part.scale.z = throb;
    }

    // Confetti: thrown with gravity, turning, gone below the tower.
    const seconds = since(frame, confetti.at) * SIXTEENTH;
    const matrix = new Matrix4();
    for (const { mesh, bits } of bursts) {
      mesh.visible = seconds >= 0;
      bits.forEach((bit, i) => {
        const position = confettiFrom.clone().addScaledVector(bit.velocity, seconds).add(new Vector3(0, -4.5 * seconds * seconds, 0));
        matrix.compose(position, new Quaternion().setFromAxisAngle(bit.axis, bit.spin * seconds), new Vector3(1, 1, 1));
        mesh.setMatrixAt(i, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }

  }

  function draw(gl: WebGLRenderer, frame: number, theme: Theme, target: WebGLRenderTarget | null): void {
    for (const { material, token } of painted) {
      const { r, g, b } = theme[token];
      material.color.setRGB(r, g, b);
    }
    for (const { tile } of cells) {
      const { r, g, b } = theme[tile.token];
      tile.material.color.setRGB(r, g, b);
    }
    page.uniforms['page']?.value.setRGB(theme.page.r, theme.page.g, theme.page.b);
    const dot = page.uniforms['dotColor'];
    if (dot !== undefined) dot.value = [theme.dot.r, theme.dot.g, theme.dot.b, theme.dot.a];
    drawHud(context, frame, theme);
    texture.needsUpdate = true;
    gl.setRenderTarget(target);
    gl.clear();
    gl.render(pageScene, screen);
    gl.render(scene, camera);
    gl.clearDepth();
    gl.render(hudScene, screen);
  }

  return {
    render(gl, frame) {
      gl.autoClear = false;
      update(frame);
      const bar = barAt(frame);
      const before = barBefore(bar);
      const t = since(frame, bar.start);
      // A new theme sweeps in from the bottom left over 2 sixteenths from the downbeat.
      if (before === undefined || before.theme === bar.theme || t >= 2) {
        draw(gl, frame, themeOf(bar.theme), null);
        return;
      }
      draw(gl, frame, themeOf(before.theme), targets[0]);
      draw(gl, frame, themeOf(bar.theme), targets[1]);
      const line = themeOf(bar.theme).line;
      wipe.uniforms['band']?.value.setRGB(line.r, line.g, line.b);
      const front = wipe.uniforms['front'];
      if (front !== undefined) front.value = interpolate(t + 0.35, [0, 2], [0, (width + height) * Math.SQRT1_2 + 3 * PX], clamp);
      gl.setRenderTarget(null);
      gl.clear();
      gl.render(wipeScene, screen);
    },
    dispose() {
      for (const target of targets) target.dispose();
      texture.dispose();
    },
  };
}
