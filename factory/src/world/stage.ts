// The renderer, camera, lights, scenery and post-processing of the Scene view. The factory stands in a
// grass field under an open sky, with rolling hills on the horizon, trees around the site and clouds
// drifting overhead.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
  /** Uniforms that animate with time: belts and the clouds share them. */
  time: { value: number };
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const SKY = {
  day: { zenith: new THREE.Color('#1765d8'), horizon: new THREE.Color('#a8d3fa') },
  dusk: { zenith: new THREE.Color('#41609e'), horizon: new THREE.Color('#f4b183') },
  night: { zenith: new THREE.Color('#060c1e'), horizon: new THREE.Color('#1d2c4b') },
};

function hash(value: number): number {
  const x = Math.sin(value * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** A gradient sky with a sun disc and its glow. It follows the camera, so it never comes closer. */
function buildSky(radius: number): { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> } {
  const uniforms = {
    uZenith: { value: SKY.day.zenith.clone() },
    uHorizon: { value: SKY.day.horizon.clone() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSun: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uSunDir;
      uniform float uSun;
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y;
        vec3 color = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.4));
        float sun = max(dot(dir, normalize(uSunDir)), 0.0);
        color += vec3(1.0, 0.93, 0.8) * (pow(sun, 1400.0) * 6.0 + pow(sun, 24.0) * 0.18) * uSun;
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, uniforms };
}

/** The grass: soft patches of green and a few dry spots, painted in the shader so it never repeats. */
function grassMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGrass;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGrass = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vGrass;
        float grassHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float grassNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(grassHash(i), grassHash(i + vec2(1.0, 0.0)), u.x), mix(grassHash(i + vec2(0.0, 1.0)), grassHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        float grassFbm(vec2 p) {
          float sum = 0.0;
          float amp = 0.5;
          for (int i = 0; i < 4; i++) { sum += grassNoise(p) * amp; p *= 2.03; amp *= 0.5; }
          return sum;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float patches = grassFbm(vGrass * 0.03);
        float dry = smoothstep(0.58, 0.78, grassFbm(vGrass * 0.011 + 17.0));
        float blades = grassNoise(vGrass * 1.7);
        vec3 grass = mix(vec3(0.085, 0.24, 0.035), vec3(0.17, 0.38, 0.06), patches);
        grass = mix(grass, vec3(0.32, 0.36, 0.1), dry * 0.55);
        diffuseColor.rgb = grass * (0.9 + 0.16 * blades);`,
      );
  };
  return material;
}

/** Rolling hills on the horizon: low, faceted mounds in a ring around the site. */
function buildHills(radius: number): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const count = 30;
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + hash(index) * 0.3;
    const distance = radius * (1 + hash(index + 0.3) * 0.45);
    const size = radius * (0.16 + hash(index + 0.6) * 0.14);
    const hill = new THREE.IcosahedronGeometry(1, 3);
    hill.scale(size * (1.4 + hash(index + 0.9)), size * (0.22 + hash(index + 1.2) * 0.2), size);
    hill.rotateY(-angle);
    hill.translate(Math.cos(angle) * distance, -size * 0.06, Math.sin(angle) * distance);
    const color = new THREE.Color('#4f8a3a').lerp(new THREE.Color('#2f6a34'), hash(index + 1.5));
    const colors = new Float32Array(hill.attributes.position!.count * 3);
    for (let v = 0; v < colors.length; v += 3) {
      colors[v] = color.r;
      colors[v + 1] = color.g;
      colors[v + 2] = color.b;
    }
    hill.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(hill);
  }
  const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.receiveShadow = true;
  return mesh;
}

/** Trees around the site, in loose groves: round leafy ones and tall conifers. */
function buildTrees(bounds: Bounds, reach: number): THREE.Group {
  const group = new THREE.Group();
  const keepOut = { minX: bounds.minX - 14, maxX: bounds.maxX + 14, minZ: bounds.minZ - 14, maxZ: bounds.maxZ + 14 };
  const spots: { x: number; z: number; s: number; conifer: boolean }[] = [];
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  for (let index = 0; spots.length < 900 && index < 20000; index += 1) {
    const x = cx + (hash(index * 2.1) * 2 - 1) * reach;
    const z = cz + (hash(index * 3.7 + 1) * 2 - 1) * reach;
    if (x > keepOut.minX && x < keepOut.maxX && z > keepOut.minZ && z < keepOut.maxZ) continue;
    if (Math.hypot(x - cx, z - cz) > reach) continue;
    // Groves: keep a tree only where a coarse noise says so.
    const grove = Math.sin(x * 0.021 + 1.3) * Math.cos(z * 0.017 - 0.7) + Math.sin((x + z) * 0.009) * 0.6;
    if (grove < 0.15 && hash(index + 9.1) > 0.08) continue;
    spots.push({ x, z, s: 0.8 + hash(index + 4.4) * 0.8, conifer: hash(index + 5.5) > 0.55 });
  }

  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.32, 1, 6).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: '#6b4a2f' }), spots.length);
  const leafy = spots.filter((spot) => !spot.conifer);
  const conifers = spots.filter((spot) => spot.conifer);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.6, 1), new THREE.MeshLambertMaterial({ flatShading: true }), leafy.length);
  const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 4.2, 7).translate(0, 2.1, 0), new THREE.MeshLambertMaterial({ flatShading: true }), conifers.length);
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const color = new THREE.Color();
  spots.forEach((spot, index) => {
    const height = spot.conifer ? 1.2 : 2.2;
    trunks.setMatrixAt(index, matrix.compose(pos.set(spot.x, -0.2, spot.z), quat.identity(), scale.set(spot.s, height * spot.s, spot.s)));
  });
  leafy.forEach((spot, index) => {
    quat.setFromEuler(new THREE.Euler(0, hash(spot.x) * Math.PI, 0));
    crowns.setMatrixAt(index, matrix.compose(pos.set(spot.x, -0.2 + 3.4 * spot.s, spot.z), quat, scale.set(spot.s, spot.s * 1.1, spot.s)));
    crowns.setColorAt(index, color.set('#4c9a35').lerp(new THREE.Color('#2f7a2c'), hash(spot.z)));
  });
  conifers.forEach((spot, index) => {
    cones.setMatrixAt(index, matrix.compose(pos.set(spot.x, -0.2 + 0.9 * spot.s, spot.z), quat.identity(), scale.set(spot.s, spot.s * 1.15, spot.s)));
    cones.setColorAt(index, color.set('#2c6b37').lerp(new THREE.Color('#1f5530'), hash(spot.x + spot.z)));
  });
  for (const mesh of [trunks, crowns, cones]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Puffy low-poly clouds high above the site. */
function buildClouds(extent: number): { group: THREE.Group; material: THREE.MeshLambertMaterial } {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.45, flatShading: true, fog: false });
  for (let index = 0; index < 22; index += 1) {
    const puffs: THREE.BufferGeometry[] = [];
    const count = 4 + Math.floor(hash(index + 0.2) * 4);
    for (let p = 0; p < count; p += 1) {
      const r = 6 + hash(index * 9 + p) * 7;
      puffs.push(new THREE.IcosahedronGeometry(r, 1).translate((p - count / 2) * 7 + hash(index + p * 3) * 4, hash(index * 3 + p) * 4, hash(index * 5 + p) * 6 - 3));
    }
    const cloud = new THREE.Mesh(mergeGeometries(puffs), material);
    cloud.scale.set(1, 0.55, 1);
    // A ring well outside the site, so clouds frame the horizon and never cover the factory.
    const angle = (index / 22) * Math.PI * 2 + hash(index + 7.7) * 0.25;
    const distance = extent * (1.9 + hash(index + 3.3) * 0.9);
    cloud.userData = { angle, distance };
    cloud.position.set(Math.cos(angle) * distance, extent * (0.3 + hash(index + 5.1) * 0.25), Math.sin(angle) * distance);
    cloud.scale.multiplyScalar(2.2);
    group.add(cloud);
  }
  return { group, material };
}

export function createStage(host: HTMLElement, extent: number, bounds: Bounds): Stage {
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
  scene.background = SKY.day.horizon.clone();
  scene.fog = new THREE.Fog(SKY.day.horizon.clone(), extent * 1.6, extent * 4);

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

  const hemi = new THREE.HemisphereLight('#d6ebff', '#5d7f45', 1.2);
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

  const time = { value: 0 };
  const sky = buildSky(extent * 4.2);
  scene.add(sky.mesh);

  const ground = new THREE.Mesh(new THREE.CircleGeometry(extent * 5, 96), grassMaterial());
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.22;
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(buildHills(extent * 1.7));
  scene.add(buildTrees(bounds, extent * 1.25));
  const clouds = buildClouds(extent);
  scene.add(clouds.group);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.45, 0.95);
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

  const zenith = new THREE.Color();
  const horizon = new THREE.Color();
  const NIGHT_CLOUD = new THREE.Color('#3a4560');
  const DUSK_CLOUD = new THREE.Color('#ffd2b0');
  const WHITE = new THREE.Color('#ffffff');
  function setDaylight(light: number): void {
    // light: 0 night … 1 noon. Dusk warms the horizon in between.
    const day = THREE.MathUtils.smoothstep(light, 0.15, 0.7);
    const dusk = Math.max(0, 1 - Math.abs(light - 0.35) / 0.25);
    zenith.copy(SKY.night.zenith).lerp(SKY.day.zenith, day).lerp(SKY.dusk.zenith, dusk * 0.4);
    horizon.copy(SKY.night.horizon).lerp(SKY.day.horizon, day).lerp(SKY.dusk.horizon, dusk * 0.55);
    (sky.uniforms.uZenith?.value as THREE.Color).copy(zenith);
    (sky.uniforms.uHorizon?.value as THREE.Color).copy(horizon);
    if (sky.uniforms.uSun) sky.uniforms.uSun.value = day;
    (scene.background as THREE.Color).copy(horizon);
    scene.fog?.color.copy(horizon);
    clouds.material.color.copy(NIGHT_CLOUD).lerp(WHITE, day).lerp(DUSK_CLOUD, dusk * 0.5);
    clouds.material.emissive.copy(clouds.material.color);
    clouds.material.emissiveIntensity = 0.15 + 0.35 * day;
    // At night the sun becomes a cool moon, so the factory stays readable.
    sun.intensity = 0.55 + 2.3 * THREE.MathUtils.smoothstep(light, 0.15, 0.8);
    sun.color.set(light < 0.12 ? '#9fb6ff' : light < 0.45 ? '#ffc69a' : '#fff3df');
    hemi.intensity = 0.6 + 0.7 * light;
    bloom.strength = 0.18 + (1 - light) * 0.5;
    renderer.toneMappingExposure = 1.0 + (1 - light) * 0.2;
  }

  const sunDir = new THREE.Vector3();
  let cloudTime = 0;
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
      sky.mesh.position.copy(camera.position);
      (sky.uniforms.uSunDir?.value as THREE.Vector3).copy(sunDir.subVectors(sun.position, sun.target.position).normalize());
      // The clouds circle the site slowly with the simulation clock.
      const drift = Math.max(0, time.value - cloudTime);
      cloudTime = time.value;
      for (const cloud of clouds.group.children) {
        const orbit = cloud.userData as { angle: number; distance: number };
        orbit.angle += drift * 0.004;
        cloud.position.x = Math.cos(orbit.angle) * orbit.distance;
        cloud.position.z = Math.sin(orbit.angle) * orbit.distance;
      }
      composer.render();
      labels.render(scene, camera);
    },
  };
}
