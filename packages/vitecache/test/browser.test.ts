import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { key } from '../src/key.js';

let CacheEntry: typeof import('../src/browser.js').CacheEntry;

function server(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(new URL(input instanceof Request ? input.url : input.toString()), init);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function discovery(installed: boolean): Response {
  return installed ? Response.json({ vitecache: 1 }) : new Response(null, { status: 404 });
}

function binary(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/octet-stream' } });
}

beforeEach(async () => {
  vi.resetModules();
  CacheEntry = (await import('../src/browser.js')).CacheEntry;
  vi.stubGlobal('location', { href: 'https://example.test/app/' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('an entry without URL dependencies is one request for its bytes, under a pinned key', async () => {
  // Pinned so that a change to how keys are derived never goes unnoticed: it would orphan every saved entry.
  const expected = '9ad9c5893f70b7d2b58dee2062ea146348878c76846cd4eb41acda8ad2854796';
  const options = { version: 'unit@1', dependencies: { unit: { value: { x: [1, 2], level: 0 } }, generation: { value: '5b0c' } } };
  expect(key(options.version, options.dependencies)).toBe(expected);
  const fetch = server((url, init) => {
    // Entry names do not change with their contents, so the browser may keep the bytes but must revalidate them.
    expect(init?.cache).toBe('no-cache');
    return binary(url.pathname === `/_vitecache/${expected}.bin` ? [5] : [6]);
  });
  expect(await new CacheEntry(options).load()).toEqual(new Uint8Array([5]));
  // The plugin checks file and package dependencies itself, so they cost no request either.
  expect(await new CacheEntry({ version: 'checked@1', dependencies: { source: { path: 'src/source.ts' }, engine: { package: 'layout' } } }).load()).toEqual(new Uint8Array([6]));
  expect(fetch.mock.calls).toHaveLength(2);
});

test('misses are 204 from the plugin, 404 or an SPA page from a static host', async () => {
  for (const response of [new Response(null, { status: 204 }), new Response(null, { status: 404 }), new Response('<html>SPA</html>', { headers: { 'Content-Type': 'text/html' } })]) {
    server(() => response);
    expect(await new CacheEntry({ version: 'missing@1' }).load()).toBeUndefined();
  }
});

test('server, hosting and network failures reject without fallback', async () => {
  server(() => new Response(null, { status: 500 }));
  await expect(new CacheEntry({ version: 'broken@1' }).load()).rejects.toThrow('HTTP 500');
  server(() => Response.json({ broken: 'hosting' }));
  await expect(new CacheEntry({ version: 'bad-mime@1' }).load()).rejects.toThrow(/content type/);
  server(() => { throw new Error('offline'); });
  await expect(new CacheEntry({ version: 'offline@1' }).load()).rejects.toThrow('offline');
});

test('a save writes nothing and warns once per version', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetch = server(() => { throw new Error('Must not request anything'); });
  const entry = new CacheEntry({ version: 'browser@1', dependencies: { source: { url: '/source.ts' } } });
  await entry.save(new Uint8Array([1]));
  await new CacheEntry({ version: 'browser@1' }).save(new Uint8Array([1]), { dependencies: { helper: { url: '/helper.ts' } } });
  await new CacheEntry({ version: 'other@1' }).save(new Uint8Array([1]));
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('browser@1 was computed in the browser'));
  expect(fetch).not.toHaveBeenCalled();
});

test('URL dependencies resolve through the plugin, and one without a backing file misses', async () => {
  let missing = false;
  server((url, init) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('resolve')) {
      expect(init?.body).toBe(JSON.stringify({ dependencies: { model: { url: 'https://example.test/model.glb' }, parameters: { value: { ratio: 0.5 } } } }));
      if (missing) return Response.json({ status: 'missing', message: 'gone' });
      return Response.json({ dependencies: { model: { path: 'public/model.glb' }, parameters: { value: { ratio: 0.5 } } } });
    }
    expect(url.pathname).toContain(key('resolved@1', { model: { path: 'public/model.glb' }, parameters: { value: { ratio: 0.5 } } }));
    return binary([2]);
  });
  const values = { ratio: 0.5 };
  const options = { version: 'resolved@1', dependencies: { model: { url: '/model.glb' }, parameters: { value: values } } };
  const entry = new CacheEntry(options);
  // An entry keeps its declaration, though the caller changes its objects.
  values.ratio = 1;
  options.dependencies.model.url = '/changed.glb';
  expect(await entry.load()).toEqual(new Uint8Array([2]));
  missing = true;
  expect(await entry.load()).toBeUndefined();
});

test('URL resolution preserves invalid URL and infrastructure errors', async () => {
  const options = { version: 'provenance@1', dependencies: { source: { url: '/source.bin' } } };
  for (const status of [400, 404, 500]) {
    server((url) => url.pathname.endsWith('__vitecache') ? discovery(true) : new Response(null, { status }));
    await expect(new CacheEntry(options).load()).rejects.toThrow(`HTTP ${status}`);
  }
  server(() => { throw new Error('offline'); });
  await expect(new CacheEntry(options).load()).rejects.toThrow('offline');
  await expect(new CacheEntry({ ...options, dependencies: { source: { url: 'https://foreign.test/source.bin' } } }).load()).rejects.toThrow(/same Vite project origin/);
});

test('entries on one canonical base share a discovery, and retry it after it fails', async () => {
  let offline = true;
  const fetch = server((url) => {
    if (url.pathname.endsWith('__vitecache')) return offline ? new Response(null, { status: 503 }) : discovery(true);
    if (url.pathname.endsWith('resolve')) return Response.json({ dependencies: { source: { path: 'public/source.bin' } } });
    return binary([7]);
  });
  const options = { version: 'shared@1', dependencies: { source: { url: '/source.bin' } } };
  const entries = ['./cache', '/app/./cache/', 'https://example.test:443/app/cache/'].map((basePath) => new CacheEntry({ ...options, basePath }));
  const discoveries = () => fetch.mock.calls.filter(([url]) => url.toString().endsWith('__vitecache')).length;
  const failed = await Promise.allSettled(entries.map((entry) => entry.load()));
  expect(failed).toEqual(entries.map(() => ({ status: 'rejected', reason: expect.objectContaining({ message: 'vitecache discovery failed: HTTP 503' }) })));
  expect(discoveries()).toBe(1);
  offline = false;
  expect(await Promise.all(entries.map((entry) => entry.load()))).toEqual(entries.map(() => new Uint8Array([7])));
  expect(discoveries()).toBe(2);
  expect(await new CacheEntry({ ...options, basePath: '/other/cache/' }).load()).toEqual(new Uint8Array([7]));
  expect(discoveries()).toBe(3);
});

function productionServer() {
  return server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(false);
    if (url.pathname.endsWith('paths.json')) return Response.json({ root: '../../', paths: { 'assets/model-abc.glb': 'src/model.glb' } });
    return binary([7]);
  });
}

test('production URL resolution fetches the build mapping once, and an unmapped URL misses', async () => {
  const fetch = productionServer();
  const options = { basePath: '/app/_vitecache/', dependencies: { model: { url: '/app/assets/model-abc.glb?v=1' } } };
  expect(await new CacheEntry({ ...options, version: 'production@1' }).load()).toEqual(new Uint8Array([7]));
  expect(await new CacheEntry({ ...options, version: 'production@2' }).load()).toEqual(new Uint8Array([7]));
  expect(fetch.mock.calls.filter(([url]) => url.toString().endsWith('paths.json'))).toHaveLength(1);
  expect(await new CacheEntry({ version: 'unmapped@1', dependencies: { model: { url: '/unknown.glb' } } }).load()).toBeUndefined();
});

test('production URL resolution rejects foreign URLs and a missing build mapping', async () => {
  productionServer();
  await expect(new CacheEntry({ version: 'foreign@1', dependencies: { model: { url: 'https://foreign.test/a.glb' } } }).load()).rejects.toThrow(/same Vite project origin/);
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(false) : new Response(null, { status: 404 }));
  await expect(new CacheEntry({ version: 'no-map@1', basePath: '/unbuilt/_vitecache/', dependencies: { model: { url: '/model.glb' } } }).load()).rejects.toThrow(/Missing production URL mapping/);
});

test('relative-base production mappings resolve under a deployment prefix and nested cache directory', async () => {
  const expected = key('relocated@1', { model: { path: 'src/model.glb' } });
  server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(false);
    if (url.pathname.endsWith('paths.json')) return Response.json({ root: '../../../', paths: { 'assets/model-abc.glb': 'src/model.glb' } });
    expect(url.pathname).toBe(`/deployment/nested/cache/${expected}.bin`);
    return binary([8]);
  });
  const entry = new CacheEntry({ version: 'relocated@1', basePath: '/deployment/nested/cache/', dependencies: { model: { url: '/deployment/assets/model-abc.glb' } } });
  expect(await entry.load()).toEqual(new Uint8Array([8]));
});
