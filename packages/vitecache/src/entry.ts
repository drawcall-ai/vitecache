import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { configure } from 'safe-stable-stringify';

/**
 * A file (a root-relative path, or on save() a `file:` URL) or an installed package, whose current state an entry is
 * checked against.
 */
export type Input = { readonly path: string } | { readonly package: string };

/** A function a load passes inline, which the vitecache plugin tags with its identity, which keys count it as. */
export type LoadFunction = (...args: never[]) => unknown;

/** JSON, which can hold functions that loads pass inline. */
export type Value =
  | null
  | boolean
  | number
  | string
  | LoadFunction
  | readonly Value[]
  | { readonly [key: string]: Value };

/** A value selects which result an entry holds; an input invalidates it when it changes. */
export type Dependency = { readonly value: Value } | Input;

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

/**
 * A function's identity, the SHA-256 of its importer's path and its source, which the plugin tags inline load arguments
 * with under the global symbol `vitecache.function`.
 */
function identity(value: LoadFunction): string {
  const id: unknown = Reflect.get(value, Symbol.for('vitecache.function'));
  if (typeof id !== 'string')
    throw new TypeError('vitecache values can hold only functions passed inline to a load the plugin finds.');
  return id;
}

/** JSON with sorted object keys, so that declaration order does not change the key; anything else throws. */
const stringify = configure({ strict: true });

/** The entry's name in the cache directory. Functions count as their identity. */
export function key(options: CacheEntryOptions): string {
  if (!options.version) throw new TypeError('CacheEntry requires a version.');
  for (const [name, dependency] of Object.entries(options.dependencies ?? {}))
    if ('path' in dependency && dependency.path.startsWith('file:'))
      throw new TypeError(
        `CacheEntry dependency ${name} is a file: URL, which would key differently per machine and in browsers. ` +
          'Pass it to save() instead.',
      );
  const declaration = stringify(
    { version: options.version, dependencies: options.dependencies ?? {} },
    (_, value: unknown) => (typeof value === 'function' ? { function: identity(value as LoadFunction) } : value),
  );
  if (declaration === undefined) throw new TypeError('vitecache cannot key this declaration.');
  return bytesToHex(sha256(new TextEncoder().encode(declaration)));
}
