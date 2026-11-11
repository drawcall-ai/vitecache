import { readFile } from 'node:fs/promises';

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
