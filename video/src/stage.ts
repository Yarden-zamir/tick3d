// The shared three.js parts of every video: the dotted page, the tower, the pieces, the light beam and the text
// layer, and the frame that draws them in one theme. Every material takes its color from one theme token, so a
// theme change repaints the whole frame.
import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  NoColorSpace,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  Vector3,
  type BufferGeometry,
  type MeshBasicMaterialParameters,
  type Object3D,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { CELL_COUNT, type Player, SIZE, toCoords } from '../../src/game.ts';
import { CELL, LAYER_GAP, OUTLINE, PIECE_HEIGHT, TILE_HEIGHT, cellBase } from './layout.ts';
import { PX } from './lettering.ts';
import { oShape, xShape } from './pieces.ts';
import { type Theme, type Token, readXPolygon } from './themes.ts';

// The pulse of a note: up to 1 at once, back to 0 over 2 sixteenths. 0 before the note.
export function pulse(t: number): number {
  if (t < 0 || t >= 2.25) return 0;
  return t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 2;
}

// A material and the theme token that colors it. A tile changes its token to blink or light up.
type Painted = { material: MeshBasicMaterial; token: Token };
type Paint = (token: Token, options?: MeshBasicMaterialParameters) => Painted;

export const SCREEN_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

// The page: `--page` with the `--dot` grid of 22 px (the body background of src/style.css).
const PAGE_FRAGMENT = `
uniform vec3 page; uniform vec4 dotColor; uniform float grid; uniform float inner; uniform float outer;
void main() {
  float d = length(mod(gl_FragCoord.xy, grid) - grid * 0.5);
  float a = dotColor.a * (1.0 - smoothstep(inner, outer, d));
  gl_FragColor = vec4(mix(page, dotColor.rgb, a), 1.0);
}`;

// A cylinder of length 1 along y, centred on the origin: lines and the beam scale it.
const unitCylinder = (radius: number) => new CylinderGeometry(radius, radius, 1, 12, 1, true);

// Places a unit cylinder from `a` to `b`, cut to the share `length` of the way.
function stretch(mesh: Object3D, a: Vector3, b: Vector3, length = 1): void {
  const direction = b.clone().sub(a);
  mesh.position.copy(a).addScaledVector(direction, length / 2);
  mesh.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.clone().normalize()));
  mesh.scale.set(1, Math.max(direction.length() * length, 1e-4), 1);
}

// A flat square frame from -1 to 1, with a hole of half-width `inner`.
export function squareFrame(inner: number): BufferGeometry {
  const shape = new Shape().moveTo(-1, -1).lineTo(1, -1).lineTo(1, 1).lineTo(-1, 1).lineTo(-1, -1);
  shape.holes.push(new Shape().moveTo(-inner, -inner).lineTo(-inner, inner).lineTo(inner, inner).lineTo(inner, -inner).lineTo(-inner, -inner));
  return new ShapeGeometry(shape).rotateX(-Math.PI / 2);
}

// A cell of the tower: its group (the tile, its outline and its shadow), its tile material, and every material
// of the cell. `near` is 1, or less when the cell fades near the camera.
type TowerCell = { group: Group; tile: Painted; materials: MeshBasicMaterial[]; near: number };

// A beam of `--win` light with a `--line` outline, and with `halos`, two soft halos. It is light: it shines
// through the tiles, so it draws over the tower, the widest part first, from `renderOrder` up.
type BeamOptions = { radius?: number; halos?: boolean; renderOrder?: number };
type Beam = {
  hide(): void;
  // `length`: the share of the way from `from` to `to`. `throb`: the width. `opacity`: a share of the full light.
  place(from: Vector3, to: Vector3, options?: { length?: number; throb?: number; opacity?: number }): void;
};

// A piece on a cell: the group sits on the tile, `lift` holds the body above its flat shadow.
type Piece = { group: Group; lift: Group; materials: Painted[] };

export type Stage = {
  scene: Scene;
  camera: PerspectiveCamera;
  paint: Paint;
  layers: Group[];
  cells: TowerCell[];
  beam(options?: BeamOptions): Beam;
  piece(player: Player): Piece;
  // Draws the frame in `theme` into `target` (null: the screen). `text` writes the words on the text layer.
  draw(gl: WebGLRenderer, theme: Theme, target: WebGLRenderTarget | null, text: (ctx: CanvasRenderingContext2D) => void): void;
  dispose(): void;
};

export function createStage(width: number, height: number): Stage {
  const painted: Painted[] = [];
  const paint: Paint = (token, options = {}) => {
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
  const cells = Array.from({ length: CELL_COUNT }, (_, cell): TowerCell => {
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

  // ---- The text: a canvas texture on a screen quad ----
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d') ?? (() => {
    throw new Error('no 2D canvas for the text');
  })();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = NoColorSpace;
  const textScene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
    uniforms: { map: { value: texture } },
    vertexShader: SCREEN_VERTEX,
    fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }',
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })));

  // The X and the O are read from the stylesheet once, when the first piece needs them.
  let shapes: Record<Player, { body: BufferGeometry; outline: BufferGeometry; flat: BufferGeometry }> | undefined;
  const extrude = (shape: Shape, depth: number, lift: number): BufferGeometry =>
    new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 40 }).translate(0, 0, lift).rotateX(-Math.PI / 2);
  const shapesOf = () => {
    if (shapes !== undefined) return shapes;
    const corners = readXPolygon();
    return (shapes = {
      X: { body: extrude(xShape(corners), PIECE_HEIGHT, 0), outline: extrude(xShape(corners, OUTLINE), PIECE_HEIGHT + 2 * OUTLINE, -OUTLINE), flat: new ShapeGeometry(xShape(corners)).rotateX(-Math.PI / 2) },
      O: { body: extrude(oShape(), PIECE_HEIGHT, 0), outline: extrude(oShape(OUTLINE), PIECE_HEIGHT + 2 * OUTLINE, -OUTLINE), flat: new ShapeGeometry(oShape(), 40).rotateX(-Math.PI / 2) },
    });
  };

  return {
    scene,
    camera,
    paint,
    layers,
    cells,

    // An extruded X or O with a `--line` outline and a flat `--shadow` on the tile.
    piece(player) {
      const shape = shapesOf()[player];
      const group = new Group();
      const materials = [paint(player === 'X' ? 'x' : 'o', { transparent: true }), paint('line', { side: BackSide, transparent: true }), paint('shadow', { transparent: true })];
      const [body, outline, shadow] = materials.map((entry) => entry.material);
      if (body === undefined || outline === undefined || shadow === undefined) throw new Error('a piece needs 3 materials');
      const flat = new Mesh(shape.flat, shadow);
      flat.position.set(0.07, 0.003, 0.07);
      const lift = new Group().add(new Mesh(shape.body, body), new Mesh(shape.outline, outline));
      group.add(flat, lift);
      group.position.y = TILE_HEIGHT / 2;
      return { group, lift, materials };
    },

    beam({ radius = 0.1, halos = true, renderOrder = 10 } = {}) {
      const light = { transparent: true, depthTest: false, depthWrite: false };
      const parts = [
        ...(halos ? [{ radius: 4.5 * radius, token: 'win' as const, opacity: 0.14 }, { radius: 2.4 * radius, token: 'win' as const, opacity: 0.35 }] : []),
        { radius: radius + OUTLINE, token: 'line' as const, opacity: 1 },
        { radius, token: 'win' as const, opacity: 1 },
      ].map((part, order) => {
        const options = part.token === 'line' ? { ...light, side: BackSide } : part.opacity < 1 ? { ...light, opacity: part.opacity } : light;
        const mesh = new Mesh(unitCylinder(part.radius), paint(part.token, options).material);
        mesh.renderOrder = renderOrder + order;
        scene.add(mesh);
        return { mesh, opacity: part.opacity };
      });
      return {
        hide() {
          for (const { mesh } of parts) mesh.visible = false;
        },
        place(from, to, { length = 1, throb = 1, opacity = 1 } = {}) {
          for (const part of parts) {
            part.mesh.visible = true;
            stretch(part.mesh, from, to, length);
            part.mesh.scale.x = throb;
            part.mesh.scale.z = throb;
            part.mesh.material.opacity = part.opacity * opacity;
          }
        },
      };
    },

    draw(gl, theme, target, text) {
      for (const { material, token } of painted) {
        const { r, g, b } = theme[token];
        material.color.setRGB(r, g, b);
      }
      page.uniforms['page']?.value.setRGB(theme.page.r, theme.page.g, theme.page.b);
      const dot = page.uniforms['dotColor'];
      if (dot !== undefined) dot.value = [theme.dot.r, theme.dot.g, theme.dot.b, theme.dot.a];
      text(context);
      texture.needsUpdate = true;
      gl.setRenderTarget(target);
      gl.clear();
      gl.render(pageScene, screen);
      gl.render(scene, camera);
      gl.clearDepth();
      gl.render(textScene, screen);
    },

    dispose() {
      texture.dispose();
    },
  };
}
