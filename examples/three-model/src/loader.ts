import { BufferAttribute, BufferGeometry } from 'three';
import { CacheEntry } from 'vitecache';

/**
 * Caches the geometry `create` computes. The loader knows nothing of how: the vitecache plugin warms each load in Node
 * and records what `create` used, the modules it ran and the public files it fetched through publicURL, as the entry's
 * inputs.
 */
export class CachedGeometryLoader {
  async loadAsync(create: () => Promise<BufferGeometry>): Promise<BufferGeometry> {
    const entry = new CacheEntry({ version: 'geometry@1', dependencies: { create: { value: create } } });
    let bytes = await entry.load();
    if (bytes === undefined) {
      bytes = encode(await create());
      await entry.save(bytes);
    }
    return decode(bytes);
  }
}

/** The geometry's vertex count, index count, positions, normals and indices. */
function encode(geometry: BufferGeometry): Uint8Array {
  const positions = geometry.getAttribute('position').array;
  const normals = geometry.getAttribute('normal').array;
  const index = geometry.getIndex()?.array;
  if (!(positions instanceof Float32Array && normals instanceof Float32Array && index))
    throw new Error('Expected an indexed geometry with float positions and normals.');
  const indices = Uint32Array.from(index);
  const counts = new Uint32Array([positions.length / 3, indices.length]);
  const bytes = new Uint8Array(counts.byteLength + positions.byteLength * 2 + indices.byteLength);
  let offset = 0;
  for (const array of [counts, positions, normals, indices]) {
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
    offset += array.byteLength;
  }
  return bytes;
}

function decode(bytes: Uint8Array): BufferGeometry {
  const copy = bytes.slice().buffer;
  const [vertices = 0, indices = 0] = new Uint32Array(copy, 0, 2);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(copy, 8, vertices * 3), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(copy, 8 + vertices * 12, vertices * 3), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(copy, 8 + vertices * 24, indices), 1));
  return geometry;
}
