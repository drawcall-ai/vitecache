import { hashes, paths, record } from './dependencies.js';
import { Entry } from './entry.js';
import type { Backend, CacheEntryOptions } from './types.js';
export type { CacheEntryOptions, FileDependency, FileDependencies, JsonValue } from './types.js';

function createBackend(options: CacheEntryOptions): Backend {
  const base = new URL(`${(options.basePath ?? '/_vitecache/').replace(/\/+$/, '')}/`, globalThis.location.href);
  let discovery: Promise<boolean> | undefined;

  async function discover(): Promise<boolean> {
    const response = await fetch(new URL('__vitecache', base), { cache: 'no-store' });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`vitecache discovery failed: HTTP ${response.status}`);
    // Static SPA servers may return index.html for unknown paths.
    if (!response.headers.get('content-type')?.includes('application/json')) return false;
    const data: unknown = await response.json();
    return typeof data === 'object' && data !== null && 'vitecache' in data && data.vitecache === 1;
  }

  function plugin(): Promise<boolean> {
    discovery ??= discover().catch((error: unknown) => {
      discovery = undefined;
      throw error;
    });
    return discovery;
  }

  return {
    canSave: plugin,
    async resolve(files) {
      const locators = Object.entries(files).map(([name, locator]) => {
        if (locator.path !== undefined) return [name, { path: locator.path }] satisfies [string, { path: string } | { url: string }];
        const url = new URL(locator.url, globalThis.location.href);
        if (url.origin !== new URL(globalThis.location.href).origin) throw new Error('URL dependencies must be served by the same Vite project origin.');
        return [name, { url: url.href }] satisfies [string, { path: string } | { url: string }];
      });
      if (locators.every(([, locator]) => 'path' in locator)) {
        return paths(Object.fromEntries(locators.map(([name, locator]) => [name, 'path' in locator ? locator.path : undefined])));
      }
      if (await plugin()) {
        const response = await fetch(new URL('__vitecache/resolve', base), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileDependencies: Object.fromEntries(locators) }),
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`vitecache URL resolution failed: HTTP ${response.status}`);
        const data: unknown = await response.json();
        const resolved = paths(record(data).paths);
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
      const resolved = locators.map(([name, locator]) => {
        if ('path' in locator) return [name, locator.path];
        const pathname = new URL(locator.url).pathname;
        const path = mapped[pathname];
        if (path === undefined) throw new Error(`No vitecache source file mapping for URL: ${pathname}`);
        return [name, path];
      });
      return paths(Object.fromEntries(resolved));
    },
    async snapshot(files) {
      if (!await plugin()) return undefined;
      const response = await fetch(new URL('__vitecache/snapshot', base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileDependencies: files }),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`vitecache dependency validation failed: HTTP ${response.status}`);
      const data: unknown = await response.json();
      if (typeof data !== 'object' || data === null || !('hashes' in data)) {
        throw new TypeError('Invalid vitecache dependency response.');
      }
      return data.hashes === null ? null : hashes(data.hashes);
    },
    async load(key, validate) {
      const response = await fetch(new URL(`${key}.bin`, base), { cache: 'no-store' });
      if (response.status === 404) return undefined;
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
    async save(key, value, files, expected) {
      const response = await fetch(new URL(`${key}.bin`, base), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Vitecache-Dependencies': encodeURIComponent(JSON.stringify(files)),
          'X-Vitecache-Hashes': encodeURIComponent(JSON.stringify(expected)),
        },
        body: new Uint8Array(value),
      });
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
