export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Exactly one source per dependency. Names and descriptors participate in cache identity. */
export type Dependency =
  | { readonly value: JsonValue; readonly path?: never; readonly url?: never; readonly package?: never }
  | { readonly path: string; readonly value?: never; readonly url?: never; readonly package?: never }
  | { readonly url: string; readonly value?: never; readonly path?: never; readonly package?: never }
  | { readonly package: string; readonly value?: never; readonly path?: never; readonly url?: never };
export type Dependencies<D extends Dependency = Dependency> = Readonly<Record<string, D>>;
/** A dependency passed to save(): a file, URL or package, since values select the result. */
export type SavedDependency = Exclude<Dependency, { readonly value: JsonValue }>;
export type SavedDependencies = Dependencies<SavedDependency>;
/** A dependency whose URL, if it had one, was resolved to a project path. */
export type Resolved = Exclude<Dependency, { readonly url: string }>;
/** A resolved file or package: a dependency whose current state is hashed. */
export type Hashable = Exclude<Resolved, { readonly value: JsonValue }>;

export interface CacheEntryOptions {
  /** Identifies the computation and its implementation version, for example "simplify@2". */
  version: string;
  /** Named dependencies. JSON values affect the key; file contents and installed package versions are validated in Node and by the Vite plugin. Paths are always project-root-relative. URLs resolve to those paths through Vite, or from local file: URLs in Node. Packages track only the declared package's installed version, without importing it. */
  dependencies?: Dependencies;
  /** Disk directory in Node (default public/_vitecache); URL prefix in browsers (default /_vitecache/). Excluded from the key. */
  basePath?: string;
  /** Node project root, default process.cwd(). Browser dependencies resolve against the Vite root. Excluded from the key. */
  root?: string;
}

export interface SaveOptions {
  /**
   * What the result was built from, when known only after computing it. They do not affect the key, so a save with
   * different saved dependencies replaces the same entry, and every load() rechecks them; a changed or missing one is a
   * miss. Hashed when save() runs, so one that changed after the computation read it goes unnoticed until it changes
   * again. One without a backing file makes save() throw MissingDependencyError.
   */
  dependencies?: SavedDependencies;
}
