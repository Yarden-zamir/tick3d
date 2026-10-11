// Draws the 4D view (src/tesseract/projection.ts) on a canvas: the frame of the four cubes, every cell,
// the marks, the win line and the lines through the cell under the pointer. Dragging orbits the view,
// a tap plays the cell under it, and the 4D turn can spin on its own.
import { type Camera, DEFAULT_CAMERA, type Projected, pickCell, projectAll } from './projection.ts';
import { type Board, CUBE_CELLS, type Line, SIZE, linesThrough, toCell } from './rules.ts';

type Scene = {
  board: Board;
  cube: number;
  aimed: number | undefined;
  peers: ReadonlySet<number>;
  winLine: Line | undefined;
  last: number | undefined;
  threats: { X: ReadonlySet<number>; O: ReadonlySet<number> };
};

type Callbacks = { onAim: (cell: number | undefined) => void; onPick: (cell: number) => void; onCamera: (camera: Camera) => void };

// Spin speed of the 4D turn, in radians per second: one full turn in about 16 s.
const SPIN = 0.4;
// How far the pointer may be from a cell to point at it, in cell steps. The nearest cell wins, so a wide
// reach only makes small, far cells easier to tap.
const PICK_RADIUS = 0.5;

// The corners of each cube and the frame between them: 12 edges inside each cube and, from each corner,
// one edge to the same corner of the next cube. Together they draw the tesseract.
const FRAME: readonly (readonly [number, number])[] = (() => {
  const edges: [number, number][] = [];
  const ends = [0, SIZE - 1];
  for (let cube = 0; cube < SIZE; cube++) {
    for (const layer of ends) {
      for (const row of ends) {
        for (const column of ends) {
          const here = toCell({ cube, layer, row, column });
          if (layer === 0) edges.push([here, toCell({ cube, layer: SIZE - 1, row, column })]);
          if (row === 0) edges.push([here, toCell({ cube, layer, row: SIZE - 1, column })]);
          if (column === 0) edges.push([here, toCell({ cube, layer, row, column: SIZE - 1 })]);
          if (cube < SIZE - 1) edges.push([here, here + CUBE_CELLS]);
        }
      }
    }
  }
  return edges;
})();

export type View4d = {
  draw(scene: Scene): void;
  setSpinning(spinning: boolean): void;
  setCamera(camera: Camera): void;
  setActive(active: boolean): void;
};

export function createView4d(canvas: HTMLCanvasElement, callbacks: Callbacks): View4d {
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2D canvas');
  const ctx = context;
  let camera: Camera = { ...DEFAULT_CAMERA };
  let scene: Scene | undefined;
  let points: Projected[] = projectAll(camera);
  let spinning = false;
  let active = false;
  let frame = 0;
  let lastTime = 0;
  // The size of the canvas in CSS pixels and the pixels of one cell step.
  let width = 0;
  let height = 0;
  let unit = 1;

  const toScreen = (p: Projected) => [width / 2 + p.x * unit, height / 2 - p.y * unit] as const;
  const fromScreen = (x: number, y: number) => [(x - width / 2) / unit, (height / 2 - y) / unit] as const;

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    // The board reaches about 3.6 cell steps from the middle at any turn.
    unit = Math.min(width, height) / 8;
    paint();
  }

  function paint(): void {
    if (scene === undefined || width === 0) return;
    const style = getComputedStyle(canvas);
    const color = (name: string) => style.getPropertyValue(name).trim() || '#888';
    const ink = color('--ink');
    const muted = color('--muted');
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';

    const segment = (a: number, b: number) => {
      const pa = points[a];
      const pb = points[b];
      if (pa === undefined || pb === undefined) return;
      ctx.beginPath();
      ctx.moveTo(...toScreen(pa));
      ctx.lineTo(...toScreen(pb));
      ctx.stroke();
    };

    // The frame: the selected cube drawn stronger.
    ctx.strokeStyle = muted;
    for (const [a, b] of FRAME) {
      const inSelected = Math.floor(a / CUBE_CELLS) === scene.cube && Math.floor(b / CUBE_CELLS) === scene.cube;
      ctx.globalAlpha = inSelected ? 0.75 : 0.22;
      ctx.lineWidth = inSelected ? 2 : 1;
      segment(a, b);
    }
    ctx.globalAlpha = 1;

    // The lines through the cell under the pointer.
    if (scene.aimed !== undefined) {
      ctx.strokeStyle = ink;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.5;
      for (const line of linesThrough(scene.aimed)) segment(line[0], line[3]);
      ctx.globalAlpha = 1;
    }

    // The cells, back to front, so a near piece covers a far one.
    const order = points.map((_, cell) => cell).sort((a, b) => (points[a]?.depth ?? 0) - (points[b]?.depth ?? 0));
    for (const cell of order) {
      const point = points[cell];
      if (point === undefined) continue;
      const [x, y] = toScreen(point);
      const mark = scene.board[cell];
      const r = unit * 0.16 * point.scale;
      const inSelected = Math.floor(cell / CUBE_CELLS) === scene.cube;
      if (mark === null) {
        const peer = scene.peers.has(cell) || cell === scene.aimed;
        ctx.fillStyle = cell === scene.aimed ? ink : peer ? color('--peer') : muted;
        ctx.globalAlpha = peer ? 1 : inSelected ? 0.55 : 0.28;
        ctx.beginPath();
        ctx.arc(x, y, peer ? r * 0.7 : r * 0.35, 0, Math.PI * 2);
        ctx.fill();
        if (peer) {
          ctx.strokeStyle = ink;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (mark === 'X') {
        ctx.strokeStyle = color('--x');
        ctx.lineWidth = Math.max(2, r * 0.45);
        const d = r * 0.75;
        ctx.beginPath();
        ctx.moveTo(x - d, y - d);
        ctx.lineTo(x + d, y + d);
        ctx.moveTo(x + d, y - d);
        ctx.lineTo(x - d, y + d);
        ctx.stroke();
      } else {
        ctx.strokeStyle = color('--o');
        ctx.lineWidth = Math.max(2, r * 0.4);
        ctx.beginPath();
        ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (const player of ['X', 'O'] as const) {
        if (!scene.threats[player].has(cell)) continue;
        ctx.strokeStyle = color(player === 'X' ? '--x' : '--o');
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(x, y, r * 1.15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (cell === scene.last) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.35, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // The win line, on top of everything.
    if (scene.winLine !== undefined) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 9;
      segment(scene.winLine[0], scene.winLine[3]);
      ctx.strokeStyle = color('--win');
      ctx.lineWidth = 5;
      segment(scene.winLine[0], scene.winLine[3]);
    }
  }

  const project = () => {
    points = projectAll(camera);
    paint();
  };

  function tick(time: number): void {
    frame = 0;
    if (!spinning || !active) return;
    const seconds = lastTime === 0 ? 0 : Math.min(0.1, (time - lastTime) / 1000);
    lastTime = time;
    camera = { ...camera, turn4: (camera.turn4 + seconds * SPIN) % (Math.PI * 2) };
    callbacks.onCamera(camera);
    project();
    frame = requestAnimationFrame(tick);
  }

  function startLoop(): void {
    if (frame !== 0 || !spinning || !active) return;
    lastTime = 0;
    frame = requestAnimationFrame(tick);
  }

  // ---- Pointer: hover points at a cell, a drag orbits, a tap plays ----
  let drag: { x: number; y: number; yaw: number; pitch: number; moved: boolean } | undefined;

  const cellAt = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const [x, y] = fromScreen(event.clientX - rect.left, event.clientY - rect.top);
    return pickCell(points, x, y, PICK_RADIUS);
  };

  canvas.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch, moved: false };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (drag === undefined) {
      callbacks.onAim(cellAt(event));
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    const limit = Math.PI / 2 - 0.05;
    camera = { ...camera, yaw: drag.yaw + dx * 0.01, pitch: Math.max(-limit, Math.min(limit, drag.pitch + dy * 0.01)) };
    callbacks.onCamera(camera);
    project();
  });
  canvas.addEventListener('pointerup', (event) => {
    const tapped = drag !== undefined && !drag.moved;
    drag = undefined;
    if (!tapped) return;
    const cell = cellAt(event);
    callbacks.onAim(cell);
    if (cell !== undefined) callbacks.onPick(cell);
  });
  canvas.addEventListener('pointercancel', () => (drag = undefined));
  canvas.addEventListener('pointerleave', () => {
    if (drag === undefined) callbacks.onAim(undefined);
  });

  new ResizeObserver(resize).observe(canvas);

  return {
    draw(next) {
      scene = next;
      paint();
    },
    setSpinning(next) {
      spinning = next;
      startLoop();
    },
    setCamera(next) {
      camera = next;
      project();
    },
    setActive(next) {
      active = next;
      if (active) resize();
      startLoop();
    },
  };
}
