// The picture of the smart-memory ad: the stage of src/stage.ts, the shatter into a wireframe, the ghost marks
// of the moves, the lines of the double threat and the reveal, with the text and the keypad of hud.ts.
// Everything in it is a function of the frame number.
import { DoubleSide, Mesh, Vector3 } from 'three';
import { Easing, interpolate } from 'remotion';
import type { Line } from '../../../src/game.ts';
import { seededRandom } from '../../../src/practice/practice.ts';
import { SIXTEENTH } from '../../../src/song.ts';
import { createConfetti } from '../confetti.ts';
import type { Picture } from '../Film.tsx';
import { frameOf, since } from '../grid.ts';
import { CELL, OUTLINE, TOWER_CENTER, cellBase, cellCenter } from '../layout.ts';
import type { BadgeArt } from '../lettering.ts';
import { HOME_DISTANCE, aim, clamp, cubic, ease, orbit, quad, shot } from '../rig.ts';
import { createStage, pulse, squareFrame } from '../stage.ts';
import { readTheme } from '../themes.ts';
import { areaOf } from './formats.ts';
import { MOVES, SEED, THREAT_LINES, WIN_LINE, playerOf } from './game.ts';
import { drawHud } from './hud.ts';
import { PLAN, type View, eventOf, eventsOf } from './plan.ts';

// The shatter: the cells fly out over SHATTER sixteenths and fade.
const SHATTER = 4;
// The wireframe of the hidden board, and the ghost marks: a flash, a trail, then fainter with each newer move.
const WIREFRAME = 0.2;
const TRAIL = 0.4;
const OLDER = 0.55;
const FAINT = 0.08;
// The X marks on the threat lines when they light, and the lines themselves.
const REMEMBERED = 0.8;
const BLOCKED = 0.15;

// The camera between two plan keys.
function viewAt(s16: number): View {
  const keys = PLAN.camera;
  const next = keys.findIndex((key) => key.at > s16);
  const a = keys[next < 0 ? keys.length - 1 : Math.max(0, next - 1)];
  const b = keys[next < 0 ? keys.length - 1 : next];
  if (a === undefined || b === undefined) throw new Error('the plan has no camera key');
  const w = a === b ? 0 : ease((s16 - a.at) / (b.at - a.at), 0, 1, Easing.inOut(cubic));
  const mix = (from: number, to: number) => from + (to - from) * w;
  return { azimuth: mix(a.view.azimuth, b.view.azimuth), elevation: mix(a.view.elevation, b.view.elevation), zoom: mix(a.view.zoom, b.view.zoom), lift: mix(a.view.lift, b.view.lift) };
}

// The ends of a line, `cap` past the centres of its end cells.
function ends(line: Line, cap: number): [Vector3, Vector3] {
  const from = cellCenter(line[0]);
  const to = cellCenter(line[3]);
  const reach = to.clone().sub(from).normalize().multiplyScalar(cap);
  return [from.sub(reach), to.add(reach)];
}

export function createMemoryWorld(width: number, height: number, art: BadgeArt): Picture {
  const theme = readTheme('light');
  const area = areaOf(width, height);
  const stage = createStage(width, height);
  const { scene, camera, paint, cells } = stage;
  const random = seededRandom(SEED);

  const shatter = eventOf('shatter');
  const reveal = eventOf('reveal');
  const threats = eventOf('threats');
  const shown = eventsOf('move');
  const placeOf = (move: number) => shown.find((event) => event.move === move)?.at;

  // ---- The shatter: each cell flies away from the centre of the tower, a little off the straight line ----
  const flights = cells.map((_, cell) => {
    const out = cellBase(cell).sub(TOWER_CENTER).add(new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(1.6)).normalize();
    return { out, reach: 5 + random() * 4, spin: new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(5) };
  });

  // ---- The wireframe: a thin `--line` square on each cell ----
  const wireGeometry = squareFrame(0.88);
  const wires = cells.map((_, cell) => {
    const material = paint('line', { transparent: true, side: DoubleSide, depthWrite: false }).material;
    const mesh = new Mesh(wireGeometry, material);
    mesh.scale.set(CELL / 2, 1, CELL / 2);
    mesh.position.copy(cellBase(cell));
    scene.add(mesh);
    return { mesh, material };
  });

  // ---- The pieces: in the scene, not in the cells, so a ghost stays on its cell while the cells fly ----
  const pieces = MOVES.map((cell, move) => {
    const piece = stage.piece(playerOf(move));
    piece.group.position.copy(cellBase(cell));
    scene.add(piece.group);
    return { ...piece, cell, move, at: placeOf(move) };
  });

  // ---- The threat lines, and a `--win` ring on the cell where they meet ----
  const threatBeams = THREAT_LINES.map((line) => ({ line, beam: stage.beam({ radius: 0.07, halos: false, renderOrder: 10 }), ends: ends(line, 0.25) }));
  const meetCell = THREAT_LINES[0].find((cell) => THREAT_LINES[1].includes(cell));
  if (meetCell === undefined) throw new Error('the threat lines do not meet');
  // The fork: the X move on the cell where the threat lines meet.
  const forkMove = MOVES.indexOf(meetCell);
  const ringMaterial = paint('win', { transparent: true, side: DoubleSide, depthTest: false, depthWrite: false }).material;
  const ring = new Mesh(squareFrame(0.7), ringMaterial);
  ring.renderOrder = 30;
  ring.position.copy(cellBase(meetCell)).add(new Vector3(0, OUTLINE + 0.01, 0));
  scene.add(ring);

  // ---- The reveal: the winning beam and the confetti ----
  const winBeam = stage.beam({ renderOrder: 20 });
  const [winFrom, winTo] = ends(WIN_LINE, 0.3);
  const confetti = createConfetti(stage, random);

  // The ghost of a shown move: a flash on its place, a trail, then fainter with each newer move (Hide history).
  function ghostOf(move: number, at: number, frame: number): number {
    const t = since(frame, at);
    if (t < 0) return 0;
    const newer = shown.filter((event) => event.move > move && frame >= frameOf(event.at)).map((event) => since(frame, event.at));
    const flash = interpolate(t, [0, 0.25, 4], [0, 1, TRAIL], clamp);
    // Each newer move dims the trail over 2 sixteenths.
    return Math.max(FAINT, newer.reduce((opacity, age) => opacity * interpolate(age, [0, 2], [1, OLDER], clamp), flash));
  }

  // An X mark on a threat line lights once the threats show, one cell per sixteenth along the line.
  function rememberedOf(cell: number, move: number, frame: number): number {
    if (playerOf(move) !== 'X') return 0;
    const index = THREAT_LINES.flatMap((line) => line).indexOf(cell);
    if (index < 0) return 0;
    const placed = placeOf(move);
    const from = Math.max(threats.at + (index % 4), placed ?? -Infinity);
    return interpolate(since(frame, from), [0, 0.5], [0, REMEMBERED], clamp);
  }

  function update(frame: number): void {
    const s16 = since(frame, 0);
    const v = viewAt(s16);
    const look = { ...shot(orbit(TOWER_CENTER, v.azimuth, v.elevation, HOME_DISTANCE), TOWER_CENTER.clone()), zoom: v.zoom, lift: v.lift };
    aim(camera, look, width, height, area);

    const hidden = since(frame, shatter.at);
    const revealed = since(frame, reveal.at);
    const isRevealed = revealed >= 0;
    // 0 while the board stands, 1 once it is gone.
    const blown = isRevealed ? 0 : interpolate(hidden, [0, SHATTER], [0, 1], { ...clamp, easing: Easing.out(quad) });
    const fade = isRevealed ? 1 : interpolate(hidden, [0, SHATTER], [1, 0], clamp);
    // The board snaps back in one frame, with a small swell.
    const swell = isRevealed ? 1 + 0.08 * pulse(revealed) : 1;

    cells.forEach((entry, cell) => {
      const flight = flights[cell];
      if (flight === undefined) throw new RangeError(`no flight for cell ${cell}`);
      const base = cellBase(cell);
      entry.group.position.set(base.x, 0, base.z).addScaledVector(flight.out, flight.reach * blown);
      entry.group.rotation.set(flight.spin.x * blown, flight.spin.y * blown, flight.spin.z * blown);
      entry.group.scale.setScalar(swell);
      entry.group.visible = fade > 0;
      for (const material of entry.materials) {
        material.opacity = fade;
        material.depthWrite = fade > 0.99;
      }
      const winIndex = WIN_LINE.indexOf(cell);
      entry.tile.token = isRevealed && winIndex >= 0 && since(frame, reveal.at + 1 + winIndex) >= 0 ? 'win' : 'slab';
      const wire = wires[cell];
      if (wire !== undefined) {
        wire.material.opacity = isRevealed ? 0 : interpolate(hidden, [1, SHATTER], [0, WIREFRAME], clamp);
        wire.mesh.visible = wire.material.opacity > 0;
      }
    });

    for (const piece of pieces) {
      const { cell, move, at } = piece;
      const onBoard = move < PLAN.firstMove;
      let opacity: number;
      if (isRevealed) {
        // `.board.finished`: the pieces off the winning line fade to 35 %.
        opacity = WIN_LINE.includes(cell) ? 1 : interpolate(revealed, [2, 6], [1, 0.35], clamp);
      } else {
        const board = onBoard ? fade : 0;
        const ghost = at === undefined ? 0 : ghostOf(move, at, frame);
        opacity = Math.max(board, ghost, frame >= frameOf(threats.at) && (onBoard || (at !== undefined && frame >= frameOf(at))) ? rememberedOf(cell, move, frame) : 0);
      }
      // A board piece flies with its cell. A ghost drops onto its cell on its place.
      const flight = flights[cell];
      const flying = onBoard && !isRevealed && blown > 0 && blown < 1 && flight !== undefined;
      piece.group.position.copy(cellBase(cell));
      if (flying) piece.group.position.addScaledVector(flight.out, flight.reach * blown);
      const t = at === undefined ? Infinity : since(frame, at);
      piece.lift.position.y = !isRevealed && t >= -1 && t < 0 ? 1.8 * t * t : 0;
      piece.lift.scale.setScalar((1 + 0.25 * pulse(t)) * swell);
      piece.group.visible = opacity > 0.001 && (t >= -1 || onBoard || isRevealed);
      for (const entry of piece.materials) {
        entry.material.opacity = opacity;
        entry.material.depthWrite = opacity > 0.99;
      }
    }

    // The threat lines draw over 6 sixteenths from the threats event. A line that the other player blocks dims.
    for (const { line, beam, ends: [from, to] } of threatBeams) {
      const t = since(frame, threats.at + 2);
      if (t < 0 || isRevealed) {
        beam.hide();
        continue;
      }
      const block = MOVES.findIndex((cell, move) => playerOf(move) === 'O' && line.includes(cell));
      const blockAt = block < 0 ? undefined : block < PLAN.firstMove ? -Infinity : placeOf(block);
      const blocked = blockAt !== undefined && frame >= frameOf(blockAt) ? interpolate(since(frame, blockAt), [0, 2], [1, BLOCKED], clamp) : 1;
      const fork = placeOf(forkMove);
      const throb = fork === undefined ? 0 : pulse(since(frame, fork));
      beam.place(from, to, { length: interpolate(t, [0, 6], [0, 1], clamp), opacity: 0.9 * blocked, throb: 1 + 0.6 * throb });
    }
    const ringTimes = [threats.at + 8, placeOf(forkMove)].filter((at): at is number => at !== undefined);
    const ringAge = Math.min(...ringTimes.map((at) => since(frame, at)).filter((age) => age >= 0));
    ring.visible = !isRevealed && ringAge < 3;
    ring.scale.setScalar((CELL / 2) * (1 + 0.7 * ringAge));
    ringMaterial.opacity = interpolate(ringAge, [0, 3], [1, 0], clamp);

    // The winning beam burns along the line from the first lit cell, then throbs on every beat.
    const fire = since(frame, reveal.at + 1);
    if (fire < 0) winBeam.hide();
    else winBeam.place(winFrom, winTo, { length: interpolate(fire, [0, 3], [0, 1], clamp), throb: 1 + 0.25 * pulse(fire % 4) });
    confetti.place(cellCenter(WIN_LINE[3]), since(frame, reveal.at + 2) * SIXTEENTH);
  }

  // The point on screen of the cell of the X move that the keypad just placed, for the thought line.
  function thoughtOf(frame: number): { x: number; y: number; at: number } | undefined {
    const event = shown.findLast((entry) => playerOf(entry.move) === 'X' && frame >= frameOf(entry.at));
    if (event === undefined || since(frame, event.at) > 4) return undefined;
    const cell = MOVES[event.move];
    if (cell === undefined) throw new RangeError(`no move ${event.move}`);
    const point = cellCenter(cell).project(camera);
    return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height, at: event.at };
  }

  return {
    render(gl, frame) {
      gl.autoClear = false;
      update(frame);
      stage.draw(gl, theme, null, (context) => drawHud(context, frame, theme, art, area, height, thoughtOf(frame)));
    },
    dispose() {
      stage.dispose();
    },
  };
}
