import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { digest, key } from '../src/key.js';

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

function binary(bytes: number[], hashes?: Record<string, string>): Response {
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
  if (hashes) headers.set('X-Vitecache-Dependencies', encodeURIComponent(JSON.stringify(hashes)));
  return new Response(new Uint8Array(bytes), { headers });
}

/** Splits a save body into its JSON metadata and cached bytes. */
function uploaded(body: unknown): { metadata: unknown; value: Uint8Array } {
  if (!(body instanceof Uint8Array)) throw new Error('Expected a binary save body');
  const end = 4 + new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
  return { metadata: JSON.parse(new TextDecoder().decode(body.subarray(4, end))), value: body.subarray(end) };
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

test('saves resolve saved URL dependencies through the plugin, and a missing one rejects the save', async () => {
  let missing = false;
  let saved: unknown;
  server((url, init) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('resolve')) {
      expect(init?.body).toBe(JSON.stringify({ dependencies: { helper: { url: 'https://example.test/helper.ts' } } }));
      if (missing) return Response.json({ error: 'missing-dependency', message: 'gone' }, { status: 404 });
      return Response.json({ dependencies: { helper: { path: 'public/helper.ts' } } });
    }
    if (init?.method === 'PUT') {
      ({ metadata: saved } = uploaded(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const entry = new CacheEntry({ version: 'saved@1' });
  const dependencies = { helper: { url: '/helper.ts' } };
  await entry.save(new Uint8Array([1]), { dependencies });
  expect(saved).toEqual({ dependencies: {}, hashes: {}, saved: { helper: { path: 'public/helper.ts' } } });
  missing = true;
  await expect(entry.save(new Uint8Array([1]), { dependencies })).rejects.toThrow('gone');
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

test('concurrent entries share canonical-base discovery, retry failures, and keep validation fresh', async () => {
  const original = digest(new Uint8Array([1]));
  let current = original;
  let offline = true;
  const fetch = server((url) => {
    if (url.pathname.endsWith('__vitecache')) return offline ? new Response(null, { status: 503 }) : discovery(true);
    if (url.pathname.endsWith('snapshot')) return Response.json({ status: 'available', hashes: { source: current } });
    return binary([7], { source: original });
  });
  const options = { version: 'shared@1', dependencies: { source: { path: 'public/source.bin' } } };
  const entries = [
    new CacheEntry({ ...options, basePath: './cache' }),
    new CacheEntry({ ...options, basePath: '/app/./cache/' }),
    new CacheEntry({ ...options, basePath: 'https://example.test:443/app/cache/' }),
  ];
  const discoveryCalls = () => fetch.mock.calls.filter(([url]) => url.toString().endsWith('__vitecache'));
  const failed = await Promise.allSettled(entries.map((entry) => entry.load()));
  expect(failed).toEqual(entries.map(() => ({ status: 'rejected', reason: expect.objectContaining({ message: 'vitecache discovery failed: HTTP 503' }) })));
  expect(discoveryCalls()).toHaveLength(1);

  offline = false;
  expect(await Promise.all(entries.map((entry) => entry.load()))).toEqual(entries.map(() => new Uint8Array([7])));
  expect(discoveryCalls()).toHaveLength(2);
  expect(await new CacheEntry({ ...options, basePath: './cache/' }).load()).toEqual(new Uint8Array([7]));
  expect(discoveryCalls()).toHaveLength(2);
  const snapshots = fetch.mock.calls.filter(([url]) => url.toString().endsWith('snapshot')).length;
  current = digest(new Uint8Array([2]));
  expect(await Promise.all(entries.map((entry) => entry.load()))).toEqual(entries.map(() => undefined));
  expect(discoveryCalls()).toHaveLength(2);
  expect(fetch.mock.calls.filter(([url]) => url.toString().endsWith('snapshot'))).toHaveLength(snapshots + entries.length);
  expect(await new CacheEntry({ ...options, basePath: '/other/cache/' }).load()).toBeUndefined();
  expect(discoveryCalls()).toHaveLength(3);
});

test('production reads static bytes without dependency checks, warns on has misses, and skips saves', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetch = server((url) => url.pathname.endsWith('__vitecache') ? discovery(false) : binary([2, 3]));
  const entry = new CacheEntry({ version: 'static@1', dependencies: { algorithm: { path: 'src/not-deployed.ts' }, engine: { package: 'not-installed-in-browser' }, parameters: { value: { ratio: 0.5 } } } });
  expect(await entry.load()).toEqual(new Uint8Array([2, 3]));
  expect(await entry.has()).toBe(true);
  expect(fetch.mock.calls.some(([url]) => url.toString().includes('snapshot'))).toBe(false);
  await expect(entry.save(new Uint8Array([4]))).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('save skipped'));
  warn.mockClear();
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(false) : new Response('<html>SPA</html>', { headers: { 'Content-Type': 'text/html' } }));
  const absent = new CacheEntry({ version: 'missing@1' });
  expect(await absent.load()).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
  expect(await absent.has()).toBe(false);
  expect(warn).toHaveBeenCalledOnce();
});

test('plugin validates dependencies, ignores declaration mutation, and snapshots byte views before save awaits', async () => {
  const original = digest(new Uint8Array([1]));
  let current = original;
  let saved: Uint8Array | undefined;
  const files = { '模型': { path: 'public/模型.glb' } };
  const entry = new CacheEntry({ version: 'mesh@1', dependencies: files, basePath: '/app/cache/' });
  files['模型'].path = 'changed-after-construction';
  const fetch = server((url, init) => {
    expect(url.pathname).toMatch(/^\/app\/cache\//);
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('snapshot')) {
      expect(init?.body).toBe(JSON.stringify({ dependencies: { '模型': { path: 'public/模型.glb' } } }));
      return Response.json({ status: 'available', hashes: { '模型': current } });
    }
    if (init?.method === 'PUT') {
      const { metadata, value } = uploaded(init.body);
      expect(metadata).toEqual({ dependencies: { '模型': { path: 'public/模型.glb' } }, hashes: { '模型': current }, saved: {} });
      expect(value).toEqual(new Uint8Array([0, 255]));
      saved = new Uint8Array([0, 255]);
      return new Response(null, { status: 204 });
    }
    return binary(saved ? Array.from(saved) : [], { '模型': original });
  });
  expect(await entry.load()).toEqual(new Uint8Array());
  const source = new Uint8Array([9, 0, 255, 9]);
  const saving = entry.save(source.subarray(1, 3));
  source.fill(7);
  await saving;
  current = digest(new Uint8Array([2]));
  expect(await entry.load()).toBeUndefined();
  expect(fetch.mock.calls.filter(([url]) => url.toString().endsWith('__vitecache'))).toHaveLength(1);
});

test('plugin misses and missing dependencies stay quiet, failures reject without fallback', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('snapshot')) return Response.json({ status: 'available', hashes: {} });
    return new Response(null, { status: 204 });
  });
  expect(await new CacheEntry({ version: 'missing@1' }).has()).toBe(false);
  expect(await new CacheEntry({ version: 'missing@1', dependencies: { source: { path: 'source.ts' } } }).load()).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(true) : new Response(null, { status: 500 }));
  await expect(new CacheEntry({ version: 'broken@1' }).load()).rejects.toThrow('HTTP 500');
  server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('snapshot')) return Response.json({ status: 'missing' });
    throw new Error('Must not read cached data for missing dependencies');
  });
  const missing = new CacheEntry({ version: 'missing-dep@1', dependencies: { source: { path: 'missing' } } });
  expect(await missing.load()).toBeUndefined();
  await expect(missing.save(new Uint8Array())).rejects.toThrow(/missing/);
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(true) : new Response(null, { status: 409 }));
  await expect(new CacheEntry({ version: 'failed@1' }).save(new Uint8Array())).rejects.toThrow('HTTP 409');
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(false) : Response.json({ broken: 'hosting' }));
  await expect(new CacheEntry({ version: 'bad-mime@1', basePath: '/production/_vitecache/' }).load()).rejects.toThrow(/content type/);
  server(() => { throw new Error('offline'); });
  await expect(new CacheEntry({ version: 'offline@1' }).load()).rejects.toThrow('offline');
});

test('value-only entries skip the snapshot, keep their keys, and still save', async () => {
  // Pinned so that skipping validation can never silently change cache identity.
  const expected = '9ad9c5893f70b7d2b58dee2062ea146348878c76846cd4eb41acda8ad2854796';
  const options = { version: 'unit@1', dependencies: { unit: { value: { x: [1, 2], level: 0 } }, generation: { value: '5b0c' } } };
  expect(key(options.version, options.dependencies)).toBe(expected);
  let saved: Uint8Array | undefined;
  const fetch = server((url, init) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    expect(url.pathname).toBe(`/_vitecache/${expected}.bin`);
    if (init?.method === 'PUT') {
      expect(uploaded(init.body).metadata).toMatchObject({ hashes: {} });
      saved = new Uint8Array([5]);
      return new Response(null, { status: 204 });
    }
    return saved ? binary(Array.from(saved), {}) : new Response(null, { status: 204 });
  });
  const entry = new CacheEntry(options);
  expect(await entry.load()).toBeUndefined();
  await entry.save(new Uint8Array([5]));
  expect(await new CacheEntry(options).load()).toEqual(new Uint8Array([5]));
  expect(fetch.mock.calls.some(([url]) => url.toString().includes('snapshot'))).toBe(false);
});

test('production URL resolution uses build mappings, misses unmapped URLs, and rejects foreign URLs or a missing mapping', async () => {
  server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(false);
    if (url.pathname.endsWith('paths.json')) return Response.json({ root: '../../', paths: { 'assets/model-abc.glb': 'src/model.glb' } });
    return binary([7]);
  });
  const fromUrl = new CacheEntry({ version: 'production@1', basePath: '/app/_vitecache/', dependencies: { model: { url: '/app/assets/model-abc.glb?v=1' } } });
  expect(await fromUrl.load()).toEqual(new Uint8Array([7]));
  // Like a missing file in development, a URL the build did not map is a miss.
  expect(await new CacheEntry({ version: 'unmapped@1', dependencies: { model: { url: '/unknown.glb' } } }).load()).toBeUndefined();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await new CacheEntry({ version: 'unmapped@1', dependencies: { model: { url: '/unknown.glb' } } }).has()).toBe(false);
  expect(warn).toHaveBeenCalledOnce();
  await expect(new CacheEntry({ version: 'foreign@1', dependencies: { model: { url: 'https://foreign.test/a.glb' } } }).load()).rejects.toThrow(/same Vite project origin/);
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(false) : new Response(null, { status: 404 }));
  await expect(new CacheEntry({ version: 'no-map@1', dependencies: { model: { url: '/model.glb' } } }).load()).rejects.toThrow(/Missing production URL mapping/);
});

test('lazy resolution captures declarations and retries failed URL resolution', async () => {
  const values = { ratio: 0.5 };
  const options = { version: 'lazy@1', dependencies: { model: { url: '/model.glb' }, parameters: { value: values } } };
  const entry = new CacheEntry(options);
  values.ratio = 1;
  options.dependencies.model.url = '/changed.glb';
  let attempts = 0;
  const fetch = server((url, init) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('resolve')) {
      expect(init?.body).toBe(JSON.stringify({ dependencies: { model: { url: 'https://example.test/model.glb' }, parameters: { value: { ratio: 0.5 } } } }));
      if (++attempts === 1) return new Response(null, { status: 500 });
      return Response.json({ dependencies: { model: { path: 'public/model.glb' }, parameters: { value: { ratio: 0.5 } } } });
    }
    if (url.pathname.endsWith('snapshot')) return Response.json({ status: 'available', hashes: { model: digest(new Uint8Array([1])) } });
    expect(url.pathname).toContain(key('lazy@1', { model: { path: 'public/model.glb' }, parameters: { value: { ratio: 0.5 } } }));
    return binary([2], { model: digest(new Uint8Array([1])) });
  });
  expect(fetch).not.toHaveBeenCalled();
  await expect(entry.load()).rejects.toThrow('HTTP 500');
  expect(await entry.load()).toEqual(new Uint8Array([2]));
  expect(attempts).toBe(2);
  expect('key' in entry).toBe(false);
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


test('browser saves without the plugin warn before dependency preparation or URL resolution', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetch = server(() => discovery(false));
  const entries = [
    new CacheEntry({ version: 'no-dependencies@1' }),
    new CacheEntry({ version: 'path@1', dependencies: { source: { path: 'src/source.ts' } } }),
    new CacheEntry({ version: 'url@1', dependencies: { source: { url: '/source.ts' } } }),
    new CacheEntry({ version: 'package@1', dependencies: { engine: { package: 'elkjs' } } }),
  ];
  for (const entry of entries) await expect(entry.save(new Uint8Array([1]))).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.every(([url, init]) => url.toString().endsWith('__vitecache') && init?.method !== 'PUT')).toBe(true);
});
