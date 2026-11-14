// Confetti in `--x`, `--o`, `--win` and `--slab`: thrown from a point with gravity, turning, gone below the tower.
import { DoubleSide, InstancedMesh, Matrix4, PlaneGeometry, Quaternion, Vector3 } from 'three';
import type { Stage } from './stage.ts';

const PER_COLOR = 40;

// The bits get their throw from `random`, so a seeded random gives the same confetti in every render.
export function createConfetti(stage: Stage, random: () => number): { place(from: Vector3, seconds: number): void } {
  const geometry = new PlaneGeometry(0.22, 0.14);
  const bursts = (['x', 'o', 'win', 'slab'] as const).map((token) => {
    const mesh = new InstancedMesh(geometry, stage.paint(token, { side: DoubleSide }).material, PER_COLOR);
    mesh.frustumCulled = false;
    stage.scene.add(mesh);
    const bits = Array.from({ length: PER_COLOR }, () => {
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
  return {
    // `seconds` since the throw: hidden before it.
    place(from, seconds) {
      const matrix = new Matrix4();
      for (const { mesh, bits } of bursts) {
        mesh.visible = seconds >= 0;
        bits.forEach((bit, i) => {
          const position = from.clone().addScaledVector(bit.velocity, seconds).add(new Vector3(0, -4.5 * seconds * seconds, 0));
          matrix.compose(position, new Quaternion().setFromAxisAngle(bit.axis, bit.spin * seconds), new Vector3(1, 1, 1));
          mesh.setMatrixAt(i, matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
