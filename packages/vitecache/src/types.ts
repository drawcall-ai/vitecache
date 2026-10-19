export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type FileDependency = { readonly path: string; readonly url?: never } | { readonly url: string; readonly path?: never };
export type FileDependencies = Readonly<Record<string, FileDependency>>;
export type Paths = Readonly<Record<string, string>>;
export type Hashes = Readonly<Record<string, string>>;

export interface CacheEntryOptions {
  /** Identifies the computation and its implementation version, for example "simplify@2". */
  version: string;
  /** JSON inputs. Object property order does not affect the key. Defaults to null. */
  inputs?: JsonValue;
  /** Named file locators. path is always project-root-relative; url resolves to a backing file through Vite (or a local file: URL in Node). Resolved names and paths affect the key; contents only affect validation. */
  fileDependencies?: FileDependencies;
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
  resolve(files: FileDependencies): Promise<Paths>;
  /** null means a missing dependency; undefined means validation is unavailable. */
  snapshot(files: Paths): Promise<Hashes | null | undefined>;
  load(key: string, validate: boolean): Promise<Stored | undefined>;
  save(key: string, value: Uint8Array, files: Paths, expected: Hashes): Promise<void>;
}
