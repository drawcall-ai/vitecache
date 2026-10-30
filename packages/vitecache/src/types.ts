export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Exactly one source per dependency. Names and descriptors participate in cache identity. */
export type Dependency =
  | { readonly value: JsonValue; readonly path?: never; readonly url?: never; readonly package?: never }
  | { readonly path: string; readonly value?: never; readonly url?: never; readonly package?: never }
  | { readonly url: string; readonly value?: never; readonly path?: never; readonly package?: never }
  | { readonly package: string; readonly value?: never; readonly path?: never; readonly url?: never };
export type Dependencies = Readonly<Record<string, Dependency>>;
export type ResolvedDependency = Exclude<Dependency, { readonly url: string }>;
/** A file, URL, or package dependency: one whose current state can be checked again later. */
export type SavedDependency = Exclude<Dependency, { readonly value: JsonValue }>;
export type SavedDependencies = Readonly<Record<string, SavedDependency>>;
export type ResolvedDependencies = Readonly<Record<string, ResolvedDependency>>;
export type Paths = Readonly<Record<string, string>>;
/** Dependency names mapped to file-content or installed-package-version hashes. */
export type Hashes = Readonly<Record<string, string>>;
/** Current dependency hashes, a missing dependency, or unavailable browser validation. */
export type Snapshot =
  | { readonly status: 'available'; readonly hashes: Hashes }
  | { readonly status: 'missing' }
  | { readonly status: 'unavailable' };

export interface CacheEntryOptions {
  /** Identifies the computation and its implementation version, for example "simplify@2". */
  version: string;
  /** Named dependencies sorted by name. JSON values affect the key; file contents and installed package versions are validated in Node or through the Vite plugin. Paths are always project-root-relative. URLs resolve to those paths through Vite, or from local file: URLs in Node. Packages track only the declared package's installed version, without importing it. */
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
  resolve(dependencies: Dependencies): Promise<ResolvedDependencies>;
  snapshot(dependencies: ResolvedDependencies): Promise<Snapshot>;
  load(key: string, validate: boolean): Promise<Stored | undefined>;
  /** `validation` must still match `expected`; `saved` is hashed now and rechecked on load. Neither holds values. */
  save(key: string, value: Uint8Array, validation: ResolvedDependencies, expected: Hashes, saved: ResolvedDependencies): Promise<void>;
}
