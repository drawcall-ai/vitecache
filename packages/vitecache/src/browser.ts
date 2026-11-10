import { ChangedDependenciesError, hashes, MissingDependencyError, paths, resolvedDependencies } from './dependencies.js';
import { Entry } from './entry.js';
import type { Backend, CacheEntryOptions, Dependency, Paths, Resolved } from './types.js';
export { ChangedDependenciesError, MissingDependencyError } from './dependencies.js';
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

async function discover(url: URL): Promise<boolean> {
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`vitecache discovery failed: HTTP ${response.status}`);
  // Static SPA servers may return index.html for unknown paths.
  if (!response.headers.get('content-type')?.includes('application/json')) return false;
  const data: unknown = await response.json();
  return typeof data === 'object' && data !== null && 'vitecache' in data && data.vitecache === 1;
}

const mappings = new Map<string, Promise<Paths>>();

/** The production build's served pathnames mapped to project-root-relative source paths. */
async function mapping(url: URL): Promise<Paths> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('URL dependencies require the vitecache Vite plugin during development and build. Missing production URL mapping.');
  }
  const data: unknown = await response.json();
  const manifest = responseObject(data);
  const mapped = paths(manifest.paths);
  if (typeof manifest.root !== 'string' || !/^(?:\.\.\/)+$/.test(manifest.root)) throw new Error('Invalid vitecache production mapping root.');
  const projectRoot = new URL(manifest.root, url);
  return Object.fromEntries(Object.entries(mapped).map(([served, path]) => [new URL(served, projectRoot).pathname, path]));
}

/** A JSON object that the plugin or a build answered with. */
function responseObject(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new TypeError('Invalid vitecache response.');
  return Object.fromEntries(Object.entries(data));
}

/** The plugin answers a missing file or package dependency with `{ status: 'missing', message }` on every route. */
function missingMessage(data: Record<string, unknown>): string | undefined {
  if (data.status !== 'missing') return undefined;
  if (typeof data.message !== 'string') throw new TypeError('Invalid vitecache missing dependency response.');
  return data.message;
}

function createBackend(options: CacheEntryOptions): Backend {
  const base = new URL(options.basePath ?? '/_vitecache/', globalThis.location.href);
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  base.search = '';
  base.hash = '';

  function plugin(): Promise<boolean> {
    return memoize(discoveries, new URL('__vitecache', base), discover);
  }

  return {
    canSave: plugin,
    async resolve(declared) {
      const locators = Object.entries(declared).map(([name, locator]): [string, Dependency] => {
        if (locator.url === undefined) return [name, locator];
        const url = new URL(locator.url, globalThis.location.href);
        if (url.origin !== new URL(globalThis.location.href).origin) throw new Error('URL dependencies must be served by the same Vite project origin.');
        return [name, { url: url.href }];
      });
      if (locators.every(([, locator]) => locator.url === undefined)) {
        return resolvedDependencies(Object.fromEntries(locators));
      }
      if (await plugin()) {
        const response = await fetch(new URL('__vitecache/resolve', base), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dependencies: Object.fromEntries(locators) }),
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`vitecache URL resolution failed: HTTP ${response.status}: ${await response.text()}`);
        const data = responseObject(await response.json());
        const missing = missingMessage(data);
        if (missing !== undefined) throw new MissingDependencyError(missing);
        const resolved = resolvedDependencies(data.dependencies);
        if (Object.keys(resolved).length !== locators.length || !locators.every(([name]) => Object.hasOwn(resolved, name))) {
          throw new Error('Invalid vitecache resolved dependencies.');
        }
        return resolved;
      }
      const mapped = await memoize(mappings, new URL('__vitecache/paths.json', base), mapping);
      const resolved = locators.map(([name, locator]): [string, Resolved] => {
        if (locator.url === undefined) return [name, locator];
        const pathname = new URL(locator.url).pathname;
        const path = mapped[pathname];
        // The build maps every file it deployed, so an unmapped URL has no backing file, as the plugin reports in development.
        if (path === undefined) throw new MissingDependencyError(`No vitecache source file mapping for URL: ${pathname}`);
        return [name, { path }];
      });
      return resolvedDependencies(Object.fromEntries(resolved));
    },
    async snapshot(dependencies) {
      if (!await plugin()) return { status: 'unchecked' };
      const response = await fetch(new URL('__vitecache/snapshot', base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependencies }),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`vitecache dependency validation failed: HTTP ${response.status}: ${await response.text()}`);
      const data = responseObject(await response.json());
      const missing = missingMessage(data);
      if (missing !== undefined) return { status: 'missing', message: missing };
      if (data.status !== 'current') throw new TypeError('Invalid vitecache dependency response.');
      return { status: 'current', hashes: hashes(data.hashes) };
    },
    async load(key) {
      // Entry names do not change with their contents, so cached bytes are revalidated before each use.
      const response = await fetch(new URL(`${key}.bin`, base), { cache: 'no-cache' });
      // The plugin answers misses with 204 so they stay out of the console; static hosts answer 404.
      if (response.status === 204 || response.status === 404) return undefined;
      if (!response.ok) throw new Error(`vitecache load failed: HTTP ${response.status}`);
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (contentType === 'text/html') return undefined;
      if (contentType !== 'application/octet-stream') throw new Error(`Unexpected vitecache content type: ${contentType ?? 'missing'}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // Only the plugin sends hashes.
      const header = response.headers.get('X-Vitecache-Dependencies');
      if (header === null) return { bytes };
      const value: unknown = JSON.parse(decodeURIComponent(header));
      return { bytes, hashes: hashes(value) };
    },
    async save(key, value, { checked, expected, saved }) {
      // Metadata travels in the body: headers are capped near 16 KiB, and saved dependencies can be many.
      const metadata = new TextEncoder().encode(JSON.stringify({ checked, expected, saved }));
      const body = new Uint8Array(4 + metadata.byteLength + value.byteLength);
      new DataView(body.buffer).setUint32(0, metadata.byteLength);
      body.set(metadata, 4);
      body.set(value, 4 + metadata.byteLength);
      const response = await fetch(new URL(`${key}.bin`, base), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
      if (response.status === 409) throw new ChangedDependenciesError();
      if (!response.ok) throw new Error(`vitecache save failed: HTTP ${response.status}: ${await response.text()}`);
      if (response.status === 204) return;
      const missing = missingMessage(responseObject(await response.json()));
      if (missing === undefined) throw new TypeError('Invalid vitecache save response.');
      throw new MissingDependencyError(missing);
    },
  };
}

/** A persistent binary computation result. Pass a browser basePath matching the public cache URL, including any Vite base. */
export class CacheEntry extends Entry {
  constructor(options: CacheEntryOptions) {
    super(options, createBackend(options));
  }
}
