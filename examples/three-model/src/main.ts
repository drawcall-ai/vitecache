import {
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  DirectionalLight,
  HemisphereLight,
  Scene,
  WebGLRenderer,
} from 'three';
import { CachedGeometryLoader } from './loader.ts';

const canvas = document.querySelector('canvas');
const status = document.querySelector('output');
if (!canvas || !status) throw new Error('Missing example elements.');

const start = performance.now();
const geometry = await new CachedGeometryLoader().loadAsync(async () => {
  const { smooth } = await import('./smooth.ts');
  return smooth('/models/knot.gltf');
});
status.textContent = `Loaded ${geometry.getAttribute('position').count} vertices in ${Math.round(performance.now() - start)} ms.`;

const scene = new Scene();
scene.add(new HemisphereLight(0xe3ede8, 0x101a1b, 1.5), new DirectionalLight(0xffffff, 2));
const knot = new Mesh(geometry, new MeshStandardMaterial({ color: 0x7aa99a, roughness: 0.4 }));
scene.add(knot);
const camera = new PerspectiveCamera(40, 1, 0.1, 100);
camera.position.z = 5;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setAnimationLoop((time) => {
  const { clientWidth: width, clientHeight: height } = canvas;
  if (canvas.width !== width * devicePixelRatio || canvas.height !== height * devicePixelRatio) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  knot.rotation.set(time / 4000, time / 3000, 0);
  renderer.render(scene, camera);
});
