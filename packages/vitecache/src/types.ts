export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Exactly one source per dependency. Names and descriptors participate in cache identity. */
export type Dependency =
  | { readonly value: JsonValue; readonly path?: never; readonly url?: never; readonly package?: never }
  | { readonly path: string; readonly value?: never; readonly url?: never; readonly package?: never }
  | { readonly url: string; readonly value?: never; readonly path?: never; readonly package?: never }
  | { readonly package: string; readonly value?: never; readonly path?: never; readonly url?: never };
export type Dependencies = Readonly<Record<string, Dependency>>;
export type ResolvedDependency = Exclude<Dependency, { readonly url: string }>;
export type ResolvedDependencies = Readonly<Record<string, ResolvedDependency>>;
export type Paths = Readonly<Record<string, string>>;
export type Hashes = Readonly<Record<string, string>>;

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

export interface Stored {
  bytes: Uint8Array;
  hashes?: Hashes;
}

export interface Backend {
  canSave(): Promise<boolean>;
  resolve(dependencies: Dependencies): Promise<ResolvedDependencies>;
  /** null means a missing dependency; undefined means validation is unavailable. Values need no fingerprint. */
  snapshot(dependencies: ResolvedDependencies): Promise<Hashes | null | undefined>;
  load(key: string, validate: boolean): Promise<Stored | undefined>;
  save(key: string, value: Uint8Array, dependencies: ResolvedDependencies, expected: Hashes): Promise<void>;
}
