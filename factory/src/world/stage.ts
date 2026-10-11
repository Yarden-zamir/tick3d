// The renderer, camera, lights, ground and post-processing of the Scene view.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  labels: CSS2DRenderer;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  ground: THREE.Mesh;
  bloom: UnrealBloomPass;
  /** 0 = night, 1 = noon. */
  setDaylight(light: number): void;
  render(): void;
  resize(): void;
  /** Uniforms that animate with time: belts and the ground share them. */
  time: { value: number };
}

const DAY_SKY = new THREE.Color('#9fb4c9');
const DUSK_SKY = new THREE.Color('#d58a5c');
const NIGHT_SKY = new THREE.Color('#1b2740');

export function createStage(host: HTMLElement, extent: number): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.info.autoReset = false;
  host.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.domElement.className = 'label-layer';
  host.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = DAY_SKY.clone();
  scene.fog = new THREE.Fog(DAY_SKY.clone(), extent * 1.1, extent * 3.2);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.5, extent * 8);
  camera.position.set(0, extent * 0.75, extent * 0.95);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.485;
  controls.minDistance = 4;
  controls.maxDistance = extent * 3;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;

  const hemi = new THREE.HemisphereLight('#dfeaff', '#4a4038', 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff3df', 2.6);
  sun.position.set(-extent * 0.5, extent * 0.9, extent * 0.35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const half = extent * 0.62;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: extent * 3 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // The ground: Unity's scene grid, painted on a dark factory floor. Fine lines every cell, strong ones every 5.
  const time = { value: 0 };
  const groundMaterial = new THREE.MeshStandardMaterial({ color: '#3b4148', roughness: 0.95, metalness: 0 });
  groundMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGridWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGridWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGridWorld;\nfloat gridLine(vec2 p, float size) { vec2 g = abs(fract(p / size - 0.5) - 0.5) / fwidth(p / size); return 1.0 - min(min(g.x, g.y), 1.0); }')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float fine = gridLine(vGridWorld.xz, 5.0);
        float bold = gridLine(vGridWorld.xz, 25.0);
        float fade = 1.0 - smoothstep(60.0, 420.0, length(vGridWorld.xz - cameraPosition.xz));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.66, 0.72), (fine * 0.18 + bold * 0.32) * fade);`,
      );
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(extent * 8, extent * 8), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.22;
  ground.receiveShadow = true;
  scene.add(ground);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize(): void {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = `${width}px`;
    renderer.domElement.style.height = `${height}px`;
    labels.setSize(width, height);
    composer.setSize(width, height);
    bloom.resolution.set(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  const sky = new THREE.Color();
  function setDaylight(light: number): void {
    // light: 0 night … 1 noon. Dusk tints the sky in between.
    const dusk = Math.max(0, 1 - Math.abs(light - 0.35) / 0.25);
    sky.copy(NIGHT_SKY).lerp(DAY_SKY, THREE.MathUtils.smoothstep(light, 0.15, 0.7)).lerp(DUSK_SKY, dusk * 0.45);
    (scene.background as THREE.Color).copy(sky);
    scene.fog?.color.copy(sky);
    // At night the sun becomes a cool moon, so the factory stays readable.
    sun.intensity = 0.55 + 2.2 * THREE.MathUtils.smoothstep(light, 0.15, 0.8);
    sun.color.set(light < 0.12 ? '#9fb6ff' : light < 0.45 ? '#ffc69a' : '#fff3df');
    hemi.intensity = 0.7 + 0.5 * light;
    bloom.strength = 0.3 + (1 - light) * 0.45;
    renderer.toneMappingExposure = 0.95 + (1 - light) * 0.25;
  }

  return {
    renderer,
    scene,
    camera,
    controls,
    labels,
    sun,
    hemi,
    ground,
    bloom,
    time,
    setDaylight,
    resize,
    render() {
      renderer.info.reset();
      composer.render();
      labels.render(scene, camera);
    },
  };
}
