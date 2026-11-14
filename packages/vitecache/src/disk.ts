import type { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import type { Recorded } from './inputs.js';

/** What a load uses while the plugin warms it, each input as it was when the load got it. */
export interface Warming {
  /** The public files publicURL gave it. */
  files: Recorded[];
  /** The modules it has run, an installed package's as its package.json, as the module runner fetched them. */
  modules: () => Recorded[];
}

declare global {
  /**
   * The vitecache plugin's project in this Node process, which CacheEntry and publicURL use when given no root, the
   * keys loaded since its latest pass started, which it prunes by, and what the load it is warming uses. Set when its
   * config resolves and kept for the process; global, because Vite's module runner gives loaders their own copy of
   * vitecache. One plugin per process: a newer one, as a restarted dev server makes, takes it over, and an older one's
   * passes then prune nothing.
   */
  var vitecache:
    | { root: string; publicDir: string; loaded: Set<string>; warming: AsyncLocalStorage<Warming> }
    | undefined;
}

/** The cache directory's name in publicDir, which is also its URL below Vite's base. */
export const cacheName = '_vitecache';

export function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** The file's bytes, or undefined when it does not exist. */
export async function read(path: string): Promise<Uint8Array | undefined> {
  try {
    // A plain Uint8Array owning its buffer, as a browser's response gives, rather than a Buffer.
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
