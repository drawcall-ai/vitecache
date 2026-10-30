import { hashes, MissingDependencyError, paths, record, resolvedDependencies } from './dependencies.js';
import { Entry } from './entry.js';
import type { Backend, CacheEntryOptions, Dependency, ResolvedDependency } from './types.js';
export { MissingDependencyError } from './dependencies.js';
export type { CacheEntryOptions, Dependency, Dependencies, JsonValue, SavedDependencies, SavedDependency, SaveOptions } from './types.js';

const discoveries = new Map<string, Promise<boolean>>();

async function discover(base: URL): Promise<boolean> {
  const response = await fetch(new URL('__vitecache', base), { cache: 'no-store' });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`vitecache discovery failed: HTTP ${response.status}`);
  // Static SPA servers may return index.html for unknown paths.
  if (!response.headers.get('content-type')?.includes('application/json')) return false;
  const data: unknown = await response.json();
  return typeof data === 'object' && data !== null && 'vitecache' in data && data.vitecache === 1;
}

function discovery(base: URL): Promise<boolean> {
  const existing = discoveries.get(base.href);
  if (existing) return existing;
  const pending = discover(base).catch((error: unknown) => {
    discoveries.delete(base.href);
    throw error;
  });
  discoveries.set(base.href, pending);
  return pending;
}

/** The plugin answers a missing file or package dependency with 404 and a JSON reason. */
async function rejectMissing(response: Response): Promise<void> {
  if (response.status !== 404 || !response.headers.get('content-type')?.includes('application/json')) return;
  const error: unknown = await response.json();
  if (typeof error === 'object' && error !== null && 'error' in error && error.error === 'missing-dependency' && 'message' in error && typeof error.message === 'string') {
    throw new MissingDependencyError(error.message);
  }
}

function createBackend(options: CacheEntryOptions): Backend {
  const base = new URL(options.basePath ?? '/_vitecache/', globalThis.location.href);
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  base.search = '';
  base.hash = '';

  function plugin(): Promise<boolean> {
    return discovery(base);
  }

  return {
    canSave: plugin,
    async resolve(dependencies) {
      const locators = Object.entries(dependencies).map(([name, locator]): [string, Dependency] => {
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
        await rejectMissing(response);
        if (!response.ok) throw new Error(`vitecache URL resolution failed: HTTP ${response.status}`);
        const data: unknown = await response.json();
        const resolved = resolvedDependencies(record(data).dependencies);
        if (Object.keys(resolved).length !== locators.length || !locators.every(([name]) => Object.hasOwn(resolved, name))) {
          throw new Error('Invalid vitecache resolved dependencies.');
        }
        return resolved;
      }
      const manifestUrl = new URL('__vitecache/paths.json', base);
      const response = await fetch(manifestUrl, { cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('URL dependencies require the vitecache Vite plugin during development and build. Missing production URL mapping.');
      }
      const data: unknown = await response.json();
      const manifest = record(data);
      const mapping = paths(manifest.paths);
      if (typeof manifest.root !== 'string' || !/^(?:\.\.\/)+$/.test(manifest.root)) throw new Error('Invalid vitecache production mapping root.');
      const projectRoot = new URL(manifest.root, manifestUrl);
      const mapped = Object.fromEntries(Object.entries(mapping).map(([url, path]) => [new URL(url, projectRoot).pathname, path]));
      const resolved = locators.map(([name, locator]): [string, ResolvedDependency] => {
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
      if (!await plugin()) return { status: 'unavailable' };
      const response = await fetch(new URL('__vitecache/snapshot', base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependencies }),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`vitecache dependency validation failed: HTTP ${response.status}`);
      const data: unknown = await response.json();
      if (typeof data === 'object' && data !== null && 'status' in data && data.status === 'missing') return { status: 'missing' };
      if (typeof data !== 'object' || data === null || !('status' in data) || data.status !== 'available' || !('hashes' in data)) {
        throw new TypeError('Invalid vitecache dependency response.');
      }
      return { status: 'available', hashes: hashes(data.hashes) };
    },
    async load(key, validate) {
      const response = await fetch(new URL(`${key}.bin`, base), { cache: 'no-store' });
      // The plugin answers misses with 204 so they stay out of the console; static hosts answer 404.
      if (response.status === 204 || response.status === 404) return undefined;
      if (!response.ok) throw new Error(`vitecache load failed: HTTP ${response.status}`);
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (contentType === 'text/html') return undefined;
      if (contentType !== 'application/octet-stream') throw new Error(`Unexpected vitecache content type: ${contentType ?? 'missing'}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!validate) return { bytes };
      const header = response.headers.get('X-Vitecache-Dependencies');
      if (header === null) throw new Error('Missing vitecache dependency metadata.');
      const value: unknown = JSON.parse(decodeURIComponent(header));
      return { bytes, hashes: hashes(value) };
    },
    async save(key, value, validation, expected, saved) {
      // Metadata travels in the body: headers are capped near 16 KiB, and saved dependencies can be many.
      const metadata = new TextEncoder().encode(JSON.stringify({ dependencies: validation, hashes: expected, saved }));
      const body = new Uint8Array(4 + metadata.byteLength + value.byteLength);
      new DataView(body.buffer).setUint32(0, metadata.byteLength);
      body.set(metadata, 4);
      body.set(value, 4 + metadata.byteLength);
      const response = await fetch(new URL(`${key}.bin`, base), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
      await rejectMissing(response);
      if (!response.ok) throw new Error(`vitecache save failed: HTTP ${response.status}`);
    },
  };
}

/** A persistent binary computation result. Pass a browser basePath matching the public cache URL, including any Vite base. */
export class CacheEntry extends Entry {
  constructor(options: CacheEntryOptions) {
    super(options, createBackend(options));
  }
}
