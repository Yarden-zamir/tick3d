// The three.js scene of the spot: the stage of src/stage.ts with the moves, the threats, the beam, the confetti
// and the text of beats.json. `render` draws one frame, and everything in it is a function of the frame number.
import {
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { interpolate } from 'remotion';
import { seededRandom } from '../../src/practice/practice.ts';
import { SIXTEENTH } from '../../src/song.ts';
import { winVoices } from '../../src/sound.ts';
import { cameraAt } from './camera.ts';
import type { Picture } from './Film.tsx';
import { drawHud } from './hud.ts';
import { CELL, LAYER_GAP, OUTLINE, TILE_HEIGHT, cellCenter } from './layout.ts';
import { type BadgeArt, PX } from './lettering.ts';
import { aim, clamp } from './rig.ts';
import { SCREEN_VERTEX, createStage, pulse, squareFrame } from './stage.ts';
import { type Theme, type ThemeId, readTheme } from './themes.ts';
import { BEATS, S16_FRAMES, barAt, barBefore, eventOf, eventsOf, frameOf, since } from './timeline.ts';

// A cell closer than NEAR to the camera is not drawn, and one closer than NEAR_FADE fades, so the ride along
// the beam never clips a slab.
const NEAR = 1.5;
const NEAR_FADE = 3.2;

// The theme wipe: the new theme from the bottom left corner up to `front`, a `--line` band on the edge.
const WIPE_FRAGMENT = `
uniform sampler2D before; uniform sampler2D after; uniform vec3 band; uniform float front; uniform float bandWidth;
varying vec2 vUv;
void main() {
  float s = (gl_FragCoord.x + gl_FragCoord.y) * 0.70710678;
  vec3 color = s < front - bandWidth ? texture2D(after, vUv).rgb : (s < front ? band : texture2D(before, vUv).rgb);
  gl_FragColor = vec4(color, 1.0);
}`;

export function createWorld(width: number, height: number, art: BadgeArt): Picture {
  const themes = new Map<ThemeId, Theme>();
  const themeOf = (id: ThemeId): Theme => {
    let theme = themes.get(id);
    if (theme === undefined) themes.set(id, (theme = readTheme(id)));
    return theme;
  };

  const stage = createStage(width, height);
  const { scene, camera, paint, layers, cells } = stage;

  // The shockwave of a layer slam: a thick square `--line` frame that grows, holds, then fades.
  const frameGeometry = squareFrame(0.9);
  const shockwaves = layers.map((layer) => {
    const material = paint('line', { transparent: true, side: DoubleSide, depthWrite: false });
    const mesh = new Mesh(frameGeometry, material.material);
    layer.add(mesh);
    return { mesh, material };
  });

  // The note ring of a threat pulse: a `--win` frame that grows out of the cell and fades, so the cell reads as
  // a note ("Every cell has a note."). Like the beam it is light, so it draws over the layers above the cell.
  const ringGeometry = squareFrame(0.7);
  const rings = [...new Set(eventsOf('threat-pulse').flatMap((event) => event.cells))].map((cell) => {
    const material = paint('win', { transparent: true, side: DoubleSide, depthTest: false, depthWrite: false });
    const mesh = new Mesh(ringGeometry, material.material);
    mesh.renderOrder = 20;
    mesh.position.y = TILE_HEIGHT / 2 + OUTLINE + 0.01;
    const entry = cells[cell];
    if (entry === undefined) throw new RangeError(`no cell ${cell}`);
    entry.group.add(mesh);
    const pulses = eventsOf('threat-pulse').filter((event) => event.cells.includes(cell));
    return { mesh, material: material.material, pulses };
  });

  // ---- The pieces ----
  const pieces = BEATS.moves.map((move) => {
    const { group, lift, materials } = stage.piece(move.player);
    const cell = cells[move.cell];
    if (cell === undefined) throw new RangeError(`no cell ${move.cell}`);
    cell.group.add(group);
    return { move, group, lift, materials };
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
  const beamLight = stage.beam();

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
  const screen = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---- One frame ----
  function update(frame: number): void {
    // The camera first: the cells near it fade, and the pieces on them fade with them.
    aim(camera, cameraAt(frame, barAt(frame)), width, height);
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
        wave.material.material.opacity = interpolate(t, [3.5 - 2 / S16_FRAMES, 3.5], [1, 0], clamp);
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
    // A note ring grows from half a cell to 1.2 cells and fades out over 2 sixteenths after each pulse.
    for (const ring of rings) {
      const t = Math.min(...ring.pulses.map((event) => since(frame, event.at)).filter((age) => age >= 0));
      ring.mesh.visible = t < 2;
      const grow = (CELL / 2) * (1 + 0.7 * t);
      ring.mesh.scale.set(grow, 1, grow);
      ring.material.opacity = interpolate(t, [0, 2], [1, 0], clamp);
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

    // The beam joins the 4 lit cells on the sixteenth after the last one lights. It throbs on each note of the
    // win jingle, then on every beat.
    const fire = since(frame, beam.at + beam.line.length - 1);
    const jingleHits = winVoices(1).map((voice) => jingle.at + (voice.at ?? 0));
    const lastHit = jingleHits.at(-1) ?? jingle.at;
    const hit = frame < frameOf(lastHit) ? Math.max(...jingleHits.map((at) => pulse(since(frame, at)))) : pulse(since(frame, lastHit) % 4);
    if (fire < 0) beamLight.hide();
    else beamLight.place(beamFrom, beamTo, { length: interpolate(fire, [0, 1], [0, 1], clamp), throb: 1 + 0.25 * hit });

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
    stage.draw(gl, theme, target, (context) => drawHud(context, frame, theme, art));
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
      stage.dispose();
    },
  };
}
