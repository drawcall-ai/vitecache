import { LoadingManager, Mesh, type BufferGeometry } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { publicURL } from 'vitecache';

// Node lacks ProgressEvent, which three.js's FileLoader reports progress with.
globalThis.ProgressEvent ??= class extends Event {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
  constructor(type: string, init: ProgressEventInit = {}) {
    super(type, init);
    this.lengthComputable = init.lengthComputable ?? false;
    this.loaded = init.loaded ?? 0;
    this.total = init.total ?? 0;
  }
};

/**
 * The meshes of the glTF model at `url` as one geometry in world space, with its seams welded and smooth normals across
 * them. In Node, publicURL gives three.js the model's files, the .gltf and the .bin it references, and records them as
 * inputs of the load that runs this.
 */
export async function smooth(url: string): Promise<BufferGeometry> {
  const manager = new LoadingManager();
  manager.setURLModifier(publicURL);
  const gltf = await new GLTFLoader(manager).loadAsync(url);
  gltf.scene.updateMatrixWorld();
  const geometries: BufferGeometry[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof Mesh) geometries.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
  });
  const welded = mergeVertices(mergeGeometries(geometries), 1e-4);
  welded.computeVertexNormals();
  return welded;
}
