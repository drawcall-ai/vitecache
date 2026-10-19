import { dependencies, equalHashes } from './dependencies.js';
import { identity, key } from './key.js';
import type { Backend, CacheEntryOptions, FileDependencies, Hashes, Paths } from './types.js';

export class Entry {
  readonly #identity: string;
  #resolution: Promise<{ key: string; files: Paths }> | undefined;
  readonly #files: FileDependencies;
  readonly #backend: Backend;
  #baseline: Hashes | null | undefined;
  #prepared = false;
  #pending = false;

  constructor(options: CacheEntryOptions, backend: Backend) {
    this.#files = dependencies(options.fileDependencies ?? {});
    this.#identity = identity(options);
    this.#backend = backend;
  }

  #resolve(): Promise<{ key: string; files: Paths }> {
    this.#resolution ??= this.#backend.resolve(this.#files).then((files) => ({ key: key(this.#identity, files), files })).catch((error: unknown) => {
      this.#resolution = undefined;
      throw error;
    });
    return this.#resolution;
  }

  /** Checks validity like load(). Warns on browser misses without the Vite plugin. */
  async has(): Promise<boolean> {
    const found = await this.load() !== undefined;
    if (!found && this.#baseline === undefined) {
      console.warn(`vitecache: cache miss for ${(await this.#resolve()).key}. Install the vitecache Vite plugin to generate cache files.`);
    }
    return found;
  }

  /** Returns undefined for missing or stale results. A miss captures dependency hashes until the next save attempt finishes. */
  async load(): Promise<Uint8Array | undefined> {
    const resolved = await this.#resolve();
    const snapshot = await this.#backend.snapshot(resolved.files);
    if (!this.#pending) {
      this.#baseline = snapshot;
      this.#prepared = true;
    }
    if (snapshot === null) {
      this.#pending = true;
      return undefined;
    }
    const stored = await this.#backend.load(resolved.key, snapshot !== undefined);
    if (!stored || (snapshot !== undefined && (!stored.hashes || !equalHashes(snapshot, stored.hashes)))) {
      this.#pending = true;
      return undefined;
    }
    return stored.bytes;
  }

  /** Saves bytes on disk. With dependencies, call load()/has() before computing; changed dependencies reject the save. Without the Vite plugin, browser saves warn and skip the write. */
  async save(value: Uint8Array): Promise<void> {
    const bytes = new Uint8Array(value);
    const expected = this.#baseline;
    try {
      if (!await this.#backend.canSave()) {
        console.warn('vitecache: save skipped. Install the vitecache Vite plugin to write cache files from the browser.');
        return;
      }
      if (Object.keys(this.#files).length && !this.#prepared) {
        throw new Error('Call CacheEntry.load() or has() before computing a result with file dependencies.');
      }
      if (expected === null) throw new Error('Cannot save a cache entry with missing file dependencies.');
      const resolved = await this.#resolve();
      await this.#backend.save(resolved.key, bytes, resolved.files, expected ?? {});
    } finally {
      this.#prepared = false;
      this.#pending = false;
      this.#baseline = undefined;
    }
  }
}
