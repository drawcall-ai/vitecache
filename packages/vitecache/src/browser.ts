import { key, type CacheEntryOptions, type SaveOptions } from './entry.js';
export type { CacheEntryOptions, Dependency, Input, JsonValue, SaveOptions } from './entry.js';

const warned = new Set<string>();

/** A cached result, read from the cache directory the app serves. Only Node writes entries. */
export class CacheEntry {
  readonly #version: string;
  readonly #url: URL;

  constructor(options: CacheEntryOptions) {
    this.#version = options.version;
    const base = new URL((options.basePath ?? '/_vitecache/').replace(/\/?$/, '/'), globalThis.location.href);
    this.#url = new URL(`${key(options)}.bin`, base);
  }

  /** The saved bytes, or undefined when the app serves none. */
  async load(): Promise<Uint8Array | undefined> {
    // An entry keeps its name when its bytes change, so the HTTP cache must revalidate them.
    const response = await fetch(this.#url, { cache: 'no-cache' });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`vitecache load failed: HTTP ${response.status}`);
    // Vite's dev server and SPA hosts answer a missing file with index.html.
    if (response.headers.get('content-type')?.startsWith('text/html')) return undefined;
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Writes nothing, since browsers only read. Warns once per version that its result was computed here. */
  async save(_value: Uint8Array, _options?: SaveOptions): Promise<void> {
    if (warned.has(this.#version)) return;
    warned.add(this.#version);
    console.warn(`vitecache: ${this.#version} was computed in the browser, which does not save it.`);
  }
}
