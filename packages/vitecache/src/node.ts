import { declaration, isHashable, MissingDependencyError, savedDependencies } from './dependencies.js';
import { key } from './key.js';
import { createStorage, type Input, type Storage } from './storage.js';
import type { CacheEntryOptions, Dependencies, Hashable, Resolved, SaveOptions } from './types.js';
export { MissingDependencyError } from './dependencies.js';
export type { CacheEntryOptions, Dependencies, Dependency, JsonValue, SavedDependencies, SavedDependency, SaveOptions } from './types.js';

/** A named file or package and the hash of its current state, undefined when it has none. */
interface State {
  name: string;
  dependency: Hashable;
  hash: string | undefined;
}

/**
 * A persistent binary computation result, read from and written to the cache directory on disk. Browsers only read
 * entries, so this is where results are computed and saved.
 */
export class CacheEntry {
  readonly #version: string;
  readonly #dependencies: Dependencies;
  readonly #storage: Storage;
  /** What the last load() found the result's inputs to be, which save() records as what it was built from. */
  #loaded: { key: string; inputs: State[] } | undefined;

  constructor(options: CacheEntryOptions) {
    ({ version: this.#version, dependencies: this.#dependencies } = declaration(options));
    this.#storage = createStorage(options);
  }

  #state(resolved: Dependencies<Resolved>): Promise<State[]> {
    return Promise.all(Object.entries(resolved).flatMap(([name, dependency]) =>
      isHashable(dependency) ? [this.#storage.hash(dependency).then((hash) => ({ name, dependency, hash }))] : []));
  }

  /**
   * The saved bytes while every file and package they were built from is unchanged, otherwise undefined. A hit is a plain
   * Uint8Array, not a Node Buffer, that owns its whole ArrayBuffer: its slice() copies, and its buffer can be transferred.
   */
  async load(): Promise<Uint8Array | undefined> {
    const resolved = await this.#storage.resolve(this.#dependencies);
    const inputs = await this.#state(resolved);
    this.#loaded = { key: key(this.#version, resolved), inputs };
    if (inputs.some((input) => input.hash === undefined)) return undefined;
    return (await this.#storage.load(this.#loaded.key))?.bytes;
  }

  /**
   * Saves the bytes computed after a load(), recording the declared files and packages as that load() found them: one
   * that changed during the computation makes the next load() miss. One without a backing file, such as a server route,
   * a virtual module or a package the app does not install, rejects with MissingDependencyError.
   */
  async save(value: Uint8Array, options: SaveOptions = {}): Promise<void> {
    const bytes = new Uint8Array(value);
    const loaded = this.#loaded;
    if (!loaded) throw new Error('Call CacheEntry.load() before computing the result to save.');
    const saved = await this.#storage.resolve(savedDependencies(options.dependencies ?? {}));
    const states = [...loaded.inputs, ...await this.#state(saved)];
    const inputs: Input[] = states.map(({ name, dependency, hash }) => {
      if (hash === undefined) throw new MissingDependencyError(`Missing file or package dependency: ${name}`);
      return { dependency, hash };
    });
    await this.#storage.save(loaded.key, bytes, inputs);
  }
}
