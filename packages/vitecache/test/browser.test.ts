import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CacheEntry } from '../src/browser.js';
import { digest, key } from '../src/key.js';

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

beforeEach(() => vi.stubGlobal('location', { href: 'https://example.test/app/' }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
      return Response.json({ hashes: { '模型': current } });
    }
    if (init?.method === 'PUT') {
      const headers = new Headers(init.headers);
      expect(JSON.parse(decodeURIComponent(headers.get('X-Vitecache-Dependencies') ?? ''))).toEqual({ '模型': { path: 'public/模型.glb' } });
      expect(JSON.parse(decodeURIComponent(headers.get('X-Vitecache-Hashes') ?? ''))).toEqual({ '模型': current });
      expect(init.body).toEqual(new Uint8Array([0, 255]));
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
    if (url.pathname.endsWith('snapshot')) return Response.json({ hashes: {} });
    return new Response(null, { status: 404 });
  });
  expect(await new CacheEntry({ version: 'missing@1' }).has()).toBe(false);
  expect(warn).not.toHaveBeenCalled();
  server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('snapshot')) return Response.json({ hashes: null });
    throw new Error('Must not read cached data for missing dependencies');
  });
  const missing = new CacheEntry({ version: 'missing-dep@1', dependencies: { source: { path: 'missing' } } });
  expect(await missing.load()).toBeUndefined();
  await expect(missing.save(new Uint8Array())).rejects.toThrow(/missing/);
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(true) : new Response(null, { status: 409 }));
  await expect(new CacheEntry({ version: 'failed@1' }).save(new Uint8Array())).rejects.toThrow('HTTP 409');
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(false) : Response.json({ broken: 'hosting' }));
  await expect(new CacheEntry({ version: 'bad-mime@1' }).load()).rejects.toThrow(/content type/);
  server(() => { throw new Error('offline'); });
  await expect(new CacheEntry({ version: 'offline@1' }).load()).rejects.toThrow('offline');
});


test('production URL resolution uses build mappings and rejects absent or foreign mappings', async () => {
  server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(false);
    if (url.pathname.endsWith('paths.json')) return Response.json({ root: '../../', paths: { 'assets/model-abc.glb': 'src/model.glb' } });
    return binary([7]);
  });
  const fromUrl = new CacheEntry({ version: 'production@1', basePath: '/app/_vitecache/', dependencies: { model: { url: '/app/assets/model-abc.glb?v=1' } } });
  expect(await fromUrl.load()).toEqual(new Uint8Array([7]));
  await expect(new CacheEntry({ version: 'unmapped@1', dependencies: { model: { url: '/unknown.glb' } } }).load()).rejects.toThrow(/No vitecache source/);
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
    if (url.pathname.endsWith('snapshot')) return Response.json({ hashes: { model: digest(new Uint8Array([1])) } });
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
