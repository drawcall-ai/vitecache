import { dependencies, equalHashes } from './dependencies.js';
import { key } from './key.js';
import type { Backend, CacheEntryOptions, Dependencies, Hashes, ResolvedDependencies } from './types.js';

export class Entry {
  readonly #version: string;
  #resolution: Promise<{ key: string; validation: ResolvedDependencies }> | undefined;
  readonly #dependencies: Dependencies;
  readonly #validates: boolean;
  readonly #backend: Backend;
  #baseline: Hashes | null | undefined;
  #prepared = false;
  #pending = false;

  constructor(options: CacheEntryOptions, backend: Backend) {
    if (typeof options.version !== 'string' || !options.version) throw new TypeError('CacheEntry requires a nonempty version.');
    this.#dependencies = dependencies(options.dependencies ?? {});
    this.#validates = Object.values(this.#dependencies).some((dependency) => !Object.hasOwn(dependency, 'value'));
    this.#version = options.version;
    this.#backend = backend;
  }

  #resolve(): Promise<{ key: string; validation: ResolvedDependencies }> {
    this.#resolution ??= this.#backend.resolve(this.#dependencies).then((dependencies) => ({
      key: key(this.#version, dependencies),
      validation: Object.fromEntries(Object.entries(dependencies).filter(([, dependency]) => !Object.hasOwn(dependency, 'value'))),
    })).catch((error: unknown) => {
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
    const snapshot = await this.#backend.snapshot(resolved.validation);
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

  /** Saves bytes on disk. With file or package dependencies, call load()/has() before computing; changed dependencies reject the save. Without the Vite plugin, browser saves warn and skip the write. */
  async save(value: Uint8Array): Promise<void> {
    const bytes = new Uint8Array(value);
    const expected = this.#baseline;
    try {
      if (!await this.#backend.canSave()) {
        console.warn('vitecache: save skipped. Install the vitecache Vite plugin to write cache files from the browser.');
        return;
      }
      if (this.#validates && !this.#prepared) {
        throw new Error('Call CacheEntry.load() or has() before computing a result with file or package dependencies.');
      }
      if (expected === null) throw new Error('Cannot save a cache entry with missing file or package dependencies.');
      const resolved = await this.#resolve();
      await this.#backend.save(resolved.key, bytes, resolved.validation, expected ?? {});
    } finally {
      this.#prepared = false;
      this.#pending = false;
      this.#baseline = undefined;
    }
  }
}
