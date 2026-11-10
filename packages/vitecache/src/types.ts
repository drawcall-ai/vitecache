export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Exactly one source per dependency. Names and descriptors participate in cache identity. */
export type Dependency =
  | { readonly value: JsonValue; readonly path?: never; readonly url?: never; readonly package?: never }
  | { readonly path: string; readonly value?: never; readonly url?: never; readonly package?: never }
  | { readonly url: string; readonly value?: never; readonly path?: never; readonly package?: never }
  | { readonly package: string; readonly value?: never; readonly path?: never; readonly url?: never };
export type Dependencies<D extends Dependency = Dependency> = Readonly<Record<string, D>>;
/** A dependency whose URL, if it had one, was resolved to a path. */
export type Resolved<D extends Dependency = Dependency> = Exclude<D, { readonly url: string }>;
/** A file, URL, or package dependency: unlike a value, one whose current state can be checked again later. */
export type Checked<D extends Dependency = Dependency> = Exclude<D, { readonly value: JsonValue }>;
/** A dependency passed to save(): only checked kinds, since values select the result. */
export type SavedDependency = Checked;
export type SavedDependencies = Dependencies<SavedDependency>;
/** A resolved checked dependency, a file path or a package: one whose current state can be hashed. */
export type Hashable = Resolved<Checked>;
export type Paths = Readonly<Record<string, string>>;
/** Dependency names mapped to file-content or installed-package-version hashes. */
export type Hashes = Readonly<Record<string, string>>;
/** Current dependency hashes, a missing dependency, or dependencies a browser without the plugin cannot check. */
export type Snapshot =
  | { readonly status: 'current'; readonly hashes: Hashes }
  | { readonly status: 'missing'; readonly message: string }
  | { readonly status: 'unchecked' };

export interface CacheEntryOptions {
  /** Identifies the computation and its implementation version, for example "simplify@2". */
  version: string;
  /** Named dependencies. JSON values affect the key; file contents and installed package versions are validated in Node or through the Vite plugin. Paths are always project-root-relative. URLs resolve to those paths through Vite, or from local file: URLs in Node. Packages track only the declared package's installed version, without importing it. */
  dependencies?: Dependencies;
  /** Disk directory in Node (default public/_vitecache); URL prefix in browsers (default /_vitecache/). Excluded from the key. */
  basePath?: string;
  /** Node project root, default process.cwd(). Browser dependencies resolve against the Vite root. Excluded from the key. */
  root?: string;
}

export interface SaveOptions {
  /**
   * What the result was built from, when known only after computing it. They do not affect the key, so a save with
   * different saved dependencies replaces the same entry. Rechecked by every load() where file contents are validated;
   * a changed or missing one is a miss. Hashed when save() runs, so one that changed after the computation read it goes
   * unnoticed until it changes again. One without a backing file makes save() throw MissingDependencyError. Values select
   * the result, so they belong in the constructor.
   */
  dependencies?: SavedDependencies;
}

export interface Stored {
  bytes: Uint8Array;
  hashes?: Hashes;
}

export interface Backend {
  canSave(): Promise<boolean>;
  resolve(dependencies: Dependencies): Promise<Dependencies<Resolved>>;
  snapshot(dependencies: Dependencies<Hashable>): Promise<Snapshot>;
  load(key: string): Promise<Stored | undefined>;
  save(key: string, value: Uint8Array, check: {
    /** Must still match `expected`. */
    checked: Dependencies<Hashable>;
    expected: Hashes;
    /** Hashed now and rechecked on load. */
    saved: Dependencies<Hashable>;
  }): Promise<void>;
}
