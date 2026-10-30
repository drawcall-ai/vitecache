import { dependencies, equalHashes, MissingDependencyError, savedDependencies } from './dependencies.js';
import { key } from './key.js';
import type { Backend, CacheEntryOptions, Dependencies, ResolvedDependencies, SaveOptions, Snapshot } from './types.js';

export class Entry {
  readonly #version: string;
  #resolution: Promise<{ key: string; validation: ResolvedDependencies }> | undefined;
  readonly #dependencies: Dependencies;
  readonly #validates: boolean;
  readonly #backend: Backend;
  #baseline: Snapshot | undefined;
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

  async #snapshot(): Promise<Snapshot> {
    try {
      return await this.#backend.snapshot((await this.#resolve()).validation);
    } catch (error) {
      if (!(error instanceof MissingDependencyError)) throw error;
      return { status: 'missing' };
    }
  }

  /** Checks validity like load(). Warns on browser misses without the Vite plugin. */
  async has(): Promise<boolean> {
    const found = await this.load() !== undefined;
    if (!found && !await this.#backend.canSave()) {
      console.warn(`vitecache: cache miss for ${this.#version}. Install the vitecache Vite plugin to generate cache files.`);
    }
    return found;
  }

  /** Returns undefined for missing dependencies or missing/stale results, saved dependencies included. A miss captures dependency hashes until the next save attempt finishes. */
  async load(): Promise<Uint8Array | undefined> {
    // Value dependencies are fully captured by the key, so there is nothing to validate or baseline.
    if (!this.#validates) return (await this.#backend.load((await this.#resolve()).key, false))?.bytes;
    const snapshot = await this.#snapshot();
    if (!this.#pending) {
      this.#baseline = snapshot;
      this.#prepared = true;
    }
    if (snapshot.status === 'missing') {
      this.#pending = true;
      return undefined;
    }
    const { key } = await this.#resolve();
    const stored = await this.#backend.load(key, snapshot.status === 'available');
    if (!stored || (snapshot.status === 'available' && (!stored.hashes || !equalHashes(snapshot.hashes, stored.hashes)))) {
      this.#pending = true;
      return undefined;
    }
    return stored.bytes;
  }

  /** Saves bytes on disk. With file or package dependencies, call load()/has() before computing; changed dependencies reject the save. Without the Vite plugin, browser saves warn and skip the write. */
  async save(value: Uint8Array, options: SaveOptions = {}): Promise<void> {
    const bytes = new Uint8Array(value);
    const saved = savedDependencies(options.dependencies ?? {});
    const expected = this.#baseline;
    try {
      if (!await this.#backend.canSave()) {
        console.warn('vitecache: save skipped. Install the vitecache Vite plugin to write cache files from the browser.');
        return;
      }
      if (this.#validates && !this.#prepared) {
        throw new Error('Call CacheEntry.load() or has() before computing a result with file or package dependencies.');
      }
      if (expected?.status === 'missing') throw new MissingDependencyError('Cannot save a cache entry with missing file or package dependencies.');
      const resolved = await this.#resolve();
      const hashes = expected?.status === 'available' ? expected.hashes : {};
      await this.#backend.save(resolved.key, bytes, resolved.validation, hashes, await this.#backend.resolve(saved));
    } finally {
      this.#prepared = false;
      this.#pending = false;
      this.#baseline = undefined;
    }
  }
}
