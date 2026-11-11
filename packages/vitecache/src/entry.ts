import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { configure } from 'safe-stable-stringify';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * A file, relative to the project root or as a `file:` URL, or an installed package, whose current state an entry is
 * checked against.
 */
export type Input = { readonly path: string } | { readonly package: string };

/** A JSON value selects which result an entry holds; an input invalidates it when it changes. */
export type Dependency = { readonly value: JsonValue } | Input;

export interface CacheEntryOptions {
  /** Identifies the computation and its implementation, for example "simplify@2". */
  version: string;
  /** Named dependencies. Names and declarations make up the entry's key; file contents and package versions do not. */
  dependencies?: Readonly<Record<string, Dependency>>;
  /**
   * Node: the project root, whose public/_vitecache is the cache directory. Defaults to the Vite project, and its
   * publicDir, while the vitecache plugin runs, else to process.cwd().
   */
  root?: string;
  /** Browsers: the URL the cache directory is served at, including any Vite base. Defaults to /_vitecache/. */
  basePath?: string;
}

export interface SaveOptions {
  /** Inputs the computation turned out to read. Checked on every load like declared ones, without changing the key. */
  dependencies?: readonly Input[];
}

/** JSON with sorted object keys, so that declaration order does not change the key; anything else throws. */
const stringify = configure({ strict: true });

/** The entry's name in the cache directory. */
export function key(options: CacheEntryOptions): string {
  if (!options.version) throw new TypeError('CacheEntry requires a version.');
  const declaration = stringify({ version: options.version, dependencies: options.dependencies ?? {} });
  return bytesToHex(sha256(new TextEncoder().encode(declaration)));
}
