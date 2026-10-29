// The orientation gizmo in the corner of the Scene view: colored axis cones that turn with the camera.
// A click on an axis looks along it, like Unity's scene gizmo.

import * as THREE from 'three';

interface Axis {
  dir: THREE.Vector3;
  color: string;
  label: string;
  positive: boolean;
}

const AXES: Axis[] = [
  { dir: new THREE.Vector3(1, 0, 0), color: '#e8403a', label: 'x', positive: true },
  { dir: new THREE.Vector3(0, 1, 0), color: '#7ed321', label: 'y', positive: true },
  { dir: new THREE.Vector3(0, 0, 1), color: '#3a7bff', label: 'z', positive: true },
  { dir: new THREE.Vector3(-1, 0, 0), color: '#8a8a8a', label: '', positive: false },
  { dir: new THREE.Vector3(0, -1, 0), color: '#8a8a8a', label: '', positive: false },
  { dir: new THREE.Vector3(0, 0, -1), color: '#8a8a8a', label: '', positive: false },
];

export function createAxisGizmo(canvas: HTMLCanvasElement, camera: THREE.Camera, onPick: (dir: THREE.Vector3) => void): { draw(): void } {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const size = canvas.width;
  const center = size / 2;
  const reach = size * 0.32;
  const inverse = new THREE.Quaternion();
  const projected: { axis: Axis; x: number; y: number; z: number }[] = [];

  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * size;
    const y = ((event.clientY - rect.top) / rect.height) * size;
    let best: { axis: Axis; d: number } | null = null;
    for (const point of projected) {
      const d = Math.hypot(point.x - x, point.y - y);
      if (d < size * 0.12 && (!best || d < best.d)) best = { axis: point.axis, d };
    }
    if (best) onPick(best.axis.dir.clone());
  });

  return {
    draw() {
      inverse.copy(camera.quaternion).invert();
      projected.length = 0;
      for (const axis of AXES) {
        const v = axis.dir.clone().applyQuaternion(inverse);
        projected.push({ axis, x: center + v.x * reach, y: center - v.y * reach, z: v.z });
      }
      projected.sort((a, b) => a.z - b.z);
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = 'rgba(30, 30, 30, 0.35)';
      ctx.beginPath();
      ctx.arc(center, center, size * 0.47, 0, Math.PI * 2);
      ctx.fill();
      for (const point of projected) {
        const { axis } = point;
        if (axis.positive) {
          ctx.strokeStyle = axis.color;
          ctx.lineWidth = size * 0.035;
          ctx.beginPath();
          ctx.moveTo(center, center);
          ctx.lineTo(point.x, point.y);
          ctx.stroke();
        }
        const radius = size * (axis.positive ? 0.085 : 0.06);
        ctx.fillStyle = axis.color;
        ctx.globalAlpha = point.z < -0.2 ? 0.55 : 1;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (axis.label) {
          ctx.fillStyle = '#111';
          ctx.font = `700 ${Math.round(size * 0.09)}px Inter, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(axis.label, point.x, point.y + 1);
        }
      }
      ctx.fillStyle = '#d0d0d0';
      ctx.fillRect(center - size * 0.04, center - size * 0.04, size * 0.08, size * 0.08);
    },
  };
}
