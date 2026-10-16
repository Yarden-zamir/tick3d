// The picture of the tutorial: the stage of src/stage.ts with the lines, pieces, lit cells and text of plan.ts.
// Everything in it is a function of the frame number.
import { DoubleSide, Mesh, Vector3 } from 'three';
import { interpolate } from 'remotion';
import { LINES, type Line, linesThrough } from '../../../src/game.ts';
import type { Picture } from '../Film.tsx';
import { frameOf, since } from '../grid.ts';
import { type BadgeArt, SQUARE } from '../lettering.ts';
import { CELL, OUTLINE, TILE_HEIGHT, cellCenter } from '../layout.ts';
import { aim, clamp } from '../rig.ts';
import { createStage, pulse, squareFrame } from '../stage.ts';
import { readTheme } from '../themes.ts';
import { shotAt } from './camera.ts';
import { drawText } from './hud.ts';
import { KINDS, STRONG_CELLS, isCorner, kindOf } from './lines.ts';
import { END, type Section, UNDO_LIFT, eventsOf } from './plan.ts';
import type { Point } from './hud.ts';

// The ends of a line, `cap` past the centres of its end cells.
function ends(line: Line, cap: number): [Vector3, Vector3] {
  const from = cellCenter(line[0]);
  const to = cellCenter(line[3]);
  const reach = to.clone().sub(from).normalize().multiplyScalar(cap);
  return [from.sub(reach), to.add(reach)];
}

// A thin line flashes in at full light and full width, then settles to `rest` over 4 sixteenths.
const flash = (t: number, rest: number) => interpolate(t, [0, 4], [1, rest], clamp);
// Where a line stands at a frame: drawn up to `length`, at `opacity`, `throb` wide. Undefined: hidden.
type Show = { length: number; opacity: number; throb: number };

export function createTutorialWorld(width: number, height: number, art: BadgeArt): Picture {
  const theme = readTheme('light');
  const stage = createStage(width, height);
  const { camera, paint, layers, cells } = stage;
  const live = (frame: number, at: number, section: Section) => frame >= frameOf(at) && frame < frameOf(section.end);

  // ---- Every line of the game, thin, under the pieces' light ----
  const thin = LINES.map((line) => ({ line, beam: stage.beam({ radius: 0.05, halos: false, renderOrder: 10 }), ends: ends(line, 0.2) }));

  // ---- The example lines: an X on each cell and the beam of the spot ----
  const examples = eventsOf('line').map(({ event, section }) => {
    const pieces = event.line.map((cell, i) => {
      const piece = stage.piece('X');
      const entry = cells[cell];
      if (entry === undefined) throw new RangeError(`no cell ${cell}`);
      entry.group.add(piece.group);
      return { ...piece, at: event.at + i * event.gap };
    });
    const jingles = eventsOf('jingle').filter((jingle) => jingle.section === section).map((jingle) => jingle.event.at);
    return { event, section, pieces, jingles, beam: stage.beam({ renderOrder: 20 }), ends: ends(event.line, 0.3) };
  });

  // A piece that drops onto `cell` over half a sixteenth and lands on `at`. It shows to the end of its section.
  const drop = (player: 'X' | 'O', cell: number, at: number, section: Section) => {
    const piece = stage.piece(player);
    const entry = cells[cell];
    if (entry === undefined) throw new RangeError(`no cell ${cell}`);
    entry.group.add(piece.group);
    return { ...piece, at, section };
  };
  const drops = [
    ...eventsOf('tap').map(({ event, section }) => drop('X', event.cell, event.at, section)),
    ...eventsOf('block').flatMap(({ event, section }) => event.line.slice(0, 3).map((cell, i) => drop('O', cell, event.at + i * event.gap, section))),
    ...eventsOf('turns').flatMap(({ event, section }) => event.cells.map((cell, i) => drop(i % 2 === 0 ? 'X' : 'O', cell, event.at + i * event.gap, section))),
  ];
  // The X of an undo: on its cell from the start of the section, it rises and fades over 1.5 sixteenths from
  // UNDO_LIFT after the tap.
  const undos = eventsOf('undo').map(({ event, section }) => {
    const piece = stage.piece('X');
    cells[event.cell]?.group.add(piece.group);
    return { ...piece, event, section };
  });

  // ---- "Block it": an `--o` beam along the 3 O that reaches for the fourth cell and stops short of it ----
  const blocks = eventsOf('block').map(({ event, section }) => {
    const [from, to] = ends(event.line, 0.3);
    // The beam stops half a cell before the centre of the fourth cell: at the edge of the X.
    const stop = 1 - 0.5 / from.distanceTo(to);
    return { event, section, from, to, stop, threat: event.at + 3 * event.gap, beam: stage.beam({ token: 'o', renderOrder: 20 }) };
  });

  // ---- The strong cells and the cells whose lines show: a `--win` note ring grows out of the cell ----
  const lightings: { cell: number; at: number; until: number }[] = [
    ...eventsOf('through').map(({ event, section }) => ({ cell: event.cell, at: event.at, until: section.end })),
    ...eventsOf('strong').flatMap(({ event }) => STRONG_CELLS.map((cell) => ({ cell, at: isCorner(cell) ? event.at : event.at + 4, until: END }))),
  ];
  const ringGeometry = squareFrame(0.7);
  const ring = (cell: number, token: 'win' | 'x', times: readonly number[]) => {
    const material = paint(token, { transparent: true, side: DoubleSide, depthTest: false, depthWrite: false }).material;
    const mesh = new Mesh(ringGeometry, material);
    mesh.renderOrder = 30;
    mesh.position.y = TILE_HEIGHT / 2 + OUTLINE + 0.01;
    cells[cell]?.group.add(mesh);
    return { cell, mesh, material, times };
  };
  const rings = [
    ...[...new Set(lightings.map((lit) => lit.cell))].map((cell) => ring(cell, 'win', lightings.filter((lit) => lit.cell === cell).map((lit) => lit.at))),
    // A block bursts an `--x` ring out of the fourth cell.
    ...blocks.map(({ event }) => ring(event.line[3], 'x', [event.blocked])),
  ];

  function lineShow(frame: number, line: Line): Show | undefined {
    const shows: Show[] = [];
    const add = (t: number, opacity: number, throb = 1) => {
      if (t >= 0) shows.push({ length: Math.min(1, t), opacity, throb });
    };
    for (const { event, section } of eventsOf('set')) {
      const index = event.lines.indexOf(line);
      if (!live(frame, event.at, section) || index < 0) continue;
      const t = since(frame, event.at + 0.125 * index);
      add(t, flash(t, 0.5), interpolate(t, [0, 4], [1.6, 1], clamp));
    }
    for (const { event, section } of eventsOf('all')) {
      if (!live(frame, event.at, section)) continue;
      const t = since(frame, event.at + KINDS.indexOf(kindOf(line)));
      add(t, flash(t, 0.55));
    }
    for (const { event, section } of eventsOf('through')) {
      if (!live(frame, event.at, section)) continue;
      const index = linesThrough(event.cell).indexOf(line);
      if (index < 0) continue;
      // The lines of a cell stay bright until the next cell of the section shows its lines.
      const later = eventsOf('through').some((other) => other.section === section && other.event.at > event.at && frame >= frameOf(other.event.at));
      const t = since(frame, event.at + event.gap * (index + 1));
      add(t, later ? 0.3 : 1, 1 + 0.5 * pulse(t));
    }
    return shows.reduce<Show | undefined>((best, show) => (best === undefined || show.opacity > best.opacity ? show : best), undefined);
  }

  // A cell of the tower on the centre square of the text, in its pixels (lettering.ts onSquare), with the camera
  // of the frame.
  const cellAt = (cell: number): Point => {
    const point = cellCenter(cell).project(camera);
    const unit = Math.min(width, height) / SQUARE;
    return { x: (point.x * width) / 2 / unit, y: (-point.y * height) / 2 / unit };
  };

  function update(frame: number): void {
    aim(camera, shotAt(frame), width, height);

    // Layers bump on their Classic note.
    layers.forEach((layer, index) => {
      const bump = Math.max(0, ...eventsOf('layer-pulse').filter(({ event }) => event.layer === index).map(({ event }) => pulse(since(frame, event.at))));
      layer.scale.set(1 + bump * 0.12, 1 + bump * 0.3, 1 + bump * 0.12);
    });

    // Tiles: `--slab`, and `--win` for the cells of an example line and the lit cells.
    for (const { tile, group } of cells) {
      tile.token = 'slab';
      group.scale.setScalar(1);
    }
    for (const { event, section } of examples) {
      event.line.forEach((cell, i) => {
        const entry = cells[cell];
        if (entry !== undefined && live(frame, event.at + i * event.gap, section)) entry.tile.token = 'win';
      });
    }
    for (const lit of lightings) {
      const entry = cells[lit.cell];
      if (entry !== undefined && frame >= frameOf(lit.at) && frame < frameOf(lit.until)) entry.tile.token = 'win';
    }
    // A block: the tiles of the 3 O turn `--o` on the threat, and the empty fourth tile blinks `--o` on each
    // sixteenth. On the block the fourth tile turns `--surface`, so the X stands out on it, and the O tiles go
    // back to `--slab`.
    for (const { event, section, threat } of blocks) {
      if (!live(frame, threat, section)) continue;
      const blocked = frame >= frameOf(event.blocked);
      event.line.forEach((cell, i) => {
        const entry = cells[cell];
        if (entry === undefined) return;
        if (i < 3) entry.tile.token = blocked ? 'slab' : 'o';
        else entry.tile.token = blocked ? 'surface' : Math.floor(since(frame, threat)) % 2 === 0 ? 'o' : 'slab';
      });
    }
    // A note ring grows from half a cell to 1.2 cells and fades out over 2 sixteenths; the cell swells with it.
    for (const ring of rings) {
      const t = Math.min(...ring.times.map((at) => since(frame, at)).filter((age) => age >= 0));
      ring.mesh.visible = t < 2;
      const grow = (CELL / 2) * (1 + 0.7 * t);
      ring.mesh.scale.set(grow, 1, grow);
      ring.material.opacity = interpolate(t, [0, 2], [1, 0], clamp);
      // A cell with 2 rings swells with the larger one.
      const group = cells[ring.cell]?.group;
      group?.scale.setScalar(Math.max(group.scale.x, 1 + 0.18 * pulse(t)));
    }

    // Example lines: each X drops over half a sixteenth onto its note, then the beam joins them and throbs on the
    // jingle. The drop is short, so a piece never passes over the label while the camera looks down on the tower.
    for (const { event, section, pieces, jingles, beam, ends: [from, to] } of examples) {
      for (const piece of pieces) {
        const t = since(frame, piece.at);
        piece.group.visible = t >= -0.5 && frame < frameOf(section.end);
        piece.lift.position.y = t < 0 ? 3.6 * t * t : 0;
        piece.lift.scale.setScalar(1 + 0.25 * pulse(t));
      }
      const fire = since(frame, event.at + event.line.length * event.gap);
      if (fire < 0 || frame >= frameOf(section.end)) {
        beam.hide();
        continue;
      }
      const hit = Math.max(pulse(fire), ...jingles.flatMap((at) => [0, 1, 2, 3, 4].map((i) => pulse(since(frame, at + i)))));
      beam.place(from, to, { length: interpolate(fire, [0, 1], [0, 1], clamp), throb: 1 + 0.25 * hit });
    }

    for (const piece of drops) {
      const t = since(frame, piece.at);
      piece.group.visible = t >= -0.5 && frame < frameOf(piece.section.end);
      piece.lift.position.y = t < 0 ? 3.6 * t * t : 0;
      piece.lift.scale.setScalar(1 + 0.25 * pulse(t));
    }

    for (const { group, lift, materials, event, section } of undos) {
      const t = since(frame, event.at + UNDO_LIFT);
      group.visible = frame >= frameOf(section.start) && t < 1.5;
      lift.position.y = t > 0 ? 1.6 * t * t : 0;
      for (const { material } of materials) material.opacity = interpolate(t, [0, 1.5], [1, 0], clamp);
    }

    // The O beam grows to its stop over 2 sixteenths and throbs on each beat. On the block it jolts back a
    // little and goes dim: the line is dead.
    for (const { event, section, from, to, stop, threat, beam } of blocks) {
      const t = since(frame, threat);
      if (t < 0 || frame >= frameOf(section.end)) {
        beam.hide();
        continue;
      }
      const hit = since(frame, event.blocked);
      if (hit < 0) {
        beam.place(from, to, { length: interpolate(t, [0, 2], [0, stop], clamp), throb: 1 + 0.2 * pulse(t % 4) });
        continue;
      }
      beam.place(from, to, { length: stop - 0.12 * pulse(hit), throb: 1 + 0.6 * pulse(hit), opacity: interpolate(hit, [0, 3], [1, 0.4], clamp) });
    }

    for (const { line, beam, ends: [from, to] } of thin) {
      const show = lineShow(frame, line);
      if (show === undefined) beam.hide();
      else beam.place(from, to, show);
    }
  }

  return {
    render(gl, frame) {
      gl.autoClear = false;
      update(frame);
      stage.draw(gl, theme, null, (context) => drawText(context, frame, theme, art, cellAt));
    },
    dispose() {
      stage.dispose();
    },
  };
}
