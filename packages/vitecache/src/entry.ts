import { dependencies, equalHashes, hashableDependencies, isChecked, MissingDependencyError, savedDependencies } from './dependencies.js';
import { key } from './key.js';
import type { Backend, CacheEntryOptions, Dependencies, Hashable, SaveOptions, Snapshot } from './types.js';

export class Entry {
  readonly #version: string;
  #resolution: Promise<{ key: string; checked: Dependencies<Hashable> }> | undefined;
  readonly #dependencies: Dependencies;
  readonly #hasChecked: boolean;
  readonly #backend: Backend;
  #baseline: Snapshot | undefined;
  #pending = false;

  constructor(options: CacheEntryOptions, backend: Backend) {
    if (typeof options.version !== 'string' || !options.version) throw new TypeError('CacheEntry requires a nonempty version.');
    this.#dependencies = dependencies(options.dependencies ?? {});
    this.#hasChecked = Object.values(this.#dependencies).some(isChecked);
    this.#version = options.version;
    this.#backend = backend;
  }

  #resolve(): Promise<{ key: string; checked: Dependencies<Hashable> }> {
    this.#resolution ??= this.#backend.resolve(this.#dependencies).then((dependencies) => ({
      key: key(this.#version, dependencies),
      // Values are fully captured by the key, so only the rest is checked.
      checked: Object.fromEntries(Object.entries(dependencies).flatMap(([name, dependency]) => isChecked(dependency) ? [[name, dependency] as const] : [])),
    })).catch((error: unknown) => {
      this.#resolution = undefined;
      throw error;
    });
    return this.#resolution;
  }

  async #snapshot(): Promise<Snapshot> {
    try {
      return await this.#backend.snapshot((await this.#resolve()).checked);
    } catch (error) {
      if (!(error instanceof MissingDependencyError)) throw error;
      return { status: 'missing', message: error.message };
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

  /**
   * Returns undefined for missing dependencies or missing/stale results, saved dependencies included. A miss captures
   * dependency hashes until the next save attempt finishes. A hit is a plain Uint8Array, not a Node Buffer, that owns
   * its whole ArrayBuffer in Node and browsers alike: its slice() copies, and its buffer can be transferred.
   */
  async load(): Promise<Uint8Array | undefined> {
    // Value dependencies are fully captured by the key, so there is nothing to validate or baseline.
    if (!this.#hasChecked) return (await this.#backend.load((await this.#resolve()).key))?.bytes;
    const snapshot = await this.#snapshot();
    if (!this.#pending) {
      this.#baseline = snapshot;
    }
    if (snapshot.status === 'missing') {
      this.#pending = true;
      return undefined;
    }
    const { key } = await this.#resolve();
    const stored = await this.#backend.load(key);
    if (!stored) {
      this.#pending = true;
      return undefined;
    }
    if (snapshot.status === 'current') {
      // A backend that checked dependencies serves their hashes with every entry.
      if (!stored.hashes) throw new Error('vitecache served an entry without its dependency hashes.');
      if (!equalHashes(snapshot.hashes, stored.hashes)) {
        this.#pending = true;
        return undefined;
      }
    }
    return stored.bytes;
  }

  /**
   * Saves bytes on disk. With file or package dependencies, call load()/has() before computing: a dependency that changed
   * since then rejects with ChangedDependenciesError, and one without a backing file, such as a server route, a virtual
   * module or a package the app does not install, with MissingDependencyError. Without the Vite plugin, browser saves
   * warn and skip the write.
   */
  async save(value: Uint8Array, options: SaveOptions = {}): Promise<void> {
    const bytes = new Uint8Array(value);
    const saved = savedDependencies(options.dependencies ?? {});
    const expected = this.#baseline;
    try {
      if (!await this.#backend.canSave()) {
        console.warn('vitecache: save skipped. Install the vitecache Vite plugin to write cache files from the browser.');
        return;
      }
      if (this.#hasChecked && expected === undefined) {
        throw new Error('Call CacheEntry.load() or has() before computing a result with file or package dependencies.');
      }
      if (expected?.status === 'missing') throw new MissingDependencyError(`Cannot save a cache entry with a missing dependency. ${expected.message}`);
      const resolved = await this.#resolve();
      const hashes = expected?.status === 'current' ? expected.hashes : {};
      await this.#backend.save(resolved.key, bytes, {
        checked: resolved.checked,
        expected: hashes,
        saved: hashableDependencies(await this.#backend.resolve(saved)),
      });
    } finally {
      this.#pending = false;
      this.#baseline = undefined;
    }
  }
}
