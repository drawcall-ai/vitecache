import { declaration, MissingDependencyError, paths, resolvedDependencies } from './dependencies.js';
import { key } from './key.js';
import type { CacheEntryOptions, Dependencies, Dependency, Resolved, SaveOptions } from './types.js';
export { MissingDependencyError } from './dependencies.js';
export type { CacheEntryOptions, Dependency, Dependencies, JsonValue, SavedDependencies, SavedDependency, SaveOptions } from './types.js';

/** Shares one request per URL across the page, and retries after a failure. */
function memoize<T>(cache: Map<string, Promise<T>>, url: URL, request: (url: URL) => Promise<T>): Promise<T> {
  const existing = cache.get(url.href);
  if (existing) return existing;
  const pending = request(url).catch((error: unknown) => {
    cache.delete(url.href);
    throw error;
  });
  cache.set(url.href, pending);
  return pending;
}

const discoveries = new Map<string, Promise<boolean>>();

/** Whether the Vite development plugin serves this cache directory. */
async function discover(url: URL): Promise<boolean> {
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`vitecache discovery failed: HTTP ${response.status}`);
  // Static SPA servers may return index.html for unknown paths.
  if (!response.headers.get('content-type')?.includes('application/json')) return false;
  const data: unknown = await response.json();
  return typeof data === 'object' && data !== null && 'vitecache' in data && data.vitecache === 1;
}

const mappings = new Map<string, Promise<Readonly<Record<string, string>>>>();

/** The production build's served pathnames mapped to project-root-relative source paths. */
async function mapping(url: URL): Promise<Readonly<Record<string, string>>> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('URL dependencies require the vitecache Vite plugin during development and build. Missing production URL mapping.');
  }
  const manifest = responseObject(await response.json());
  if (typeof manifest.root !== 'string' || !/^(?:\.\.\/)+$/.test(manifest.root)) throw new Error('Invalid vitecache production mapping root.');
  const projectRoot = new URL(manifest.root, url);
  return Object.fromEntries(Object.entries(paths(manifest.paths)).map(([served, path]) => [new URL(served, projectRoot).pathname, path]));
}

/** A JSON object that the plugin or a build answered with. */
function responseObject(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new TypeError('Invalid vitecache response.');
  return Object.fromEntries(Object.entries(data));
}

/** Versions whose unsaved computation this page already warned about. */
const unsaved = new Set<string>();

/**
 * A persistent binary computation result, read from the cache directory the app serves. Browsers never write entries:
 * compute them in Node, whose CacheEntry saves them there. Through the Vite development plugin, a load is a hit only while
 * the files and packages the result was built from are unchanged; a deployed app serves what was saved.
 */
export class CacheEntry {
  readonly #version: string;
  readonly #dependencies: Dependencies;
  readonly #base: URL;

  /** Pass a basePath matching the public cache URL, including any Vite base. */
  constructor(options: CacheEntryOptions) {
    ({ version: this.#version, dependencies: this.#dependencies } = declaration(options));
    this.#base = new URL(options.basePath ?? '/_vitecache/', globalThis.location.href);
    this.#base.pathname = `${this.#base.pathname.replace(/\/+$/, '')}/`;
    this.#base.search = '';
    this.#base.hash = '';
  }

  /** The saved bytes, or undefined for a missing entry, or one whose URL dependency has no backing file. */
  async load(): Promise<Uint8Array | undefined> {
    let resolved: Dependencies<Resolved>;
    try {
      resolved = await this.#resolve();
    } catch (error) {
      if (!(error instanceof MissingDependencyError)) throw error;
      return undefined;
    }
    // Entry names do not change with their contents, so cached bytes are revalidated before each use.
    const response = await fetch(new URL(`${key(this.#version, resolved)}.bin`, this.#base), { cache: 'no-cache' });
    // The plugin answers misses with 204 so they stay out of the console; static hosts answer 404.
    if (response.status === 204 || response.status === 404) return undefined;
    if (!response.ok) throw new Error(`vitecache load failed: HTTP ${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (contentType === 'text/html') return undefined;
    if (contentType !== 'application/octet-stream') throw new Error(`Unexpected vitecache content type: ${contentType ?? 'missing'}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Writes nothing, since browsers only read entries. Warns once per version that its result was computed here. */
  async save(_value: Uint8Array, _options?: SaveOptions): Promise<void> {
    if (unsaved.has(this.#version)) return;
    unsaved.add(this.#version);
    console.warn(`vitecache: ${this.#version} was computed in the browser, which does not save results. Compute it in Node to cache it.`);
  }

  /** Same-origin URL dependencies as the project paths that Node resolves them to, so that both derive the same key. */
  async #resolve(): Promise<Dependencies<Resolved>> {
    const page = new URL(globalThis.location.href);
    const declared = Object.entries(this.#dependencies).map(([name, item]): [string, Dependency] => {
      if (item.url === undefined) return [name, item];
      const url = new URL(item.url, page);
      if (url.origin !== page.origin) throw new Error('URL dependencies must be served by the same Vite project origin.');
      return [name, { url: url.href }];
    });
    if (declared.every(([, item]) => item.url === undefined)) return resolvedDependencies(Object.fromEntries(declared));
    if (await memoize(discoveries, new URL('__vitecache', this.#base), discover)) {
      const response = await fetch(new URL('__vitecache/resolve', this.#base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependencies: Object.fromEntries(declared) }),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`vitecache URL resolution failed: HTTP ${response.status}: ${await response.text()}`);
      const data = responseObject(await response.json());
      if (data.status === 'missing') throw new MissingDependencyError(typeof data.message === 'string' ? data.message : 'Missing file dependency');
      const resolved = resolvedDependencies(data.dependencies);
      if (Object.keys(resolved).length !== declared.length || !declared.every(([name]) => Object.hasOwn(resolved, name))) {
        throw new Error('Invalid vitecache resolved dependencies.');
      }
      return resolved;
    }
    const mapped = await memoize(mappings, new URL('__vitecache/paths.json', this.#base), mapping);
    return resolvedDependencies(Object.fromEntries(declared.map(([name, item]): [string, Dependency] => {
      if (item.url === undefined) return [name, item];
      const pathname = new URL(item.url).pathname;
      const path = mapped[pathname];
      // The build maps every file it deployed, so an unmapped URL has no backing file, as the plugin reports in development.
      if (path === undefined) throw new MissingDependencyError(`No vitecache source file mapping for URL: ${pathname}`);
      return [name, { path }];
    })));
  }
}
