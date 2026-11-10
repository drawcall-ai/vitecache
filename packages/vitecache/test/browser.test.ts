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
      if (missing) return Response.json({ status: 'missing', message: 'gone' });
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
  expect(saved).toEqual({ checked: {}, expected: {}, saved: { helper: { path: 'public/helper.ts' } } });
  missing = true;
  await expect(entry.save(new Uint8Array([1]), { dependencies })).rejects.toMatchObject({ name: 'MissingDependencyError', message: 'gone' });
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

/** A plugin whose discovery fails while `state.offline`, serving bytes [7] saved from source hash `original`. */
function sharedServer() {
  const original = digest(new Uint8Array([1]));
  const state = { current: original, offline: false };
  const fetch = server((url) => {
    if (url.pathname.endsWith('__vitecache')) return state.offline ? new Response(null, { status: 503 }) : discovery(true);
    if (url.pathname.endsWith('snapshot')) return Response.json({ status: 'current', hashes: { source: state.current } });
    return binary([7], { source: original });
  });
  const options = { version: 'shared@1', dependencies: { source: { path: 'public/source.bin' } } };
  const entries = [
    new CacheEntry({ ...options, basePath: './cache' }),
    new CacheEntry({ ...options, basePath: '/app/./cache/' }),
    new CacheEntry({ ...options, basePath: 'https://example.test:443/app/cache/' }),
  ];
  const calls = (suffix: string) => fetch.mock.calls.filter(([url]) => url.toString().endsWith(suffix));
  return { state, options, entries, calls };
}

test('entries on one canonical base share a discovery, and retry it after it fails', async () => {
  const { state, options, entries, calls } = sharedServer();
  state.offline = true;
  const failed = await Promise.allSettled(entries.map((entry) => entry.load()));
  expect(failed).toEqual(entries.map(() => ({ status: 'rejected', reason: expect.objectContaining({ message: 'vitecache discovery failed: HTTP 503' }) })));
  expect(calls('__vitecache')).toHaveLength(1);
  state.offline = false;
  expect(await Promise.all(entries.map((entry) => entry.load()))).toEqual(entries.map(() => new Uint8Array([7])));
  expect(calls('__vitecache')).toHaveLength(2);
  expect(await new CacheEntry({ ...options, basePath: './cache/' }).load()).toEqual(new Uint8Array([7]));
  expect(calls('__vitecache')).toHaveLength(2);
  expect(await new CacheEntry({ ...options, basePath: '/other/cache/' }).load()).toEqual(new Uint8Array([7]));
  expect(calls('__vitecache')).toHaveLength(3);
});

test('every load takes a fresh snapshot, so a changed dependency misses', async () => {
  const { state, entries, calls } = sharedServer();
  expect(await Promise.all(entries.map((entry) => entry.load()))).toEqual(entries.map(() => new Uint8Array([7])));
  const snapshots = calls('snapshot').length;
  state.current = digest(new Uint8Array([2]));
  expect(await Promise.all(entries.map((entry) => entry.load()))).toEqual(entries.map(() => undefined));
  expect(calls('snapshot')).toHaveLength(snapshots + entries.length);
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

test('an entry keeps its declarations and the byte view it saves, though callers mutate them', async () => {
  const current = digest(new Uint8Array([1]));
  const files = { '模型': { path: 'public/模型.glb' } };
  const entry = new CacheEntry({ version: 'mesh@1', dependencies: files, basePath: '/app/cache/' });
  files['模型'].path = 'changed-after-construction';
  let saved: unknown;
  server((url, init) => {
    expect(url.pathname).toMatch(/^\/app\/cache\//);
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('snapshot')) {
      expect(init?.body).toBe(JSON.stringify({ dependencies: { '模型': { path: 'public/模型.glb' } } }));
      return Response.json({ status: 'current', hashes: { '模型': current } });
    }
    if (init?.method === 'PUT') {
      saved = uploaded(init.body);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 204 });
  });
  expect(await entry.load()).toBeUndefined();
  const source = new Uint8Array([9, 0, 255, 9]);
  const saving = entry.save(source.subarray(1, 3));
  source.fill(7);
  await saving;
  expect(saved).toEqual({ metadata: { checked: { '模型': { path: 'public/模型.glb' } }, expected: { '模型': current }, saved: {} }, value: new Uint8Array([0, 255]) });
});

test('bytes without hashes reject when the plugin checked dependencies, and value-only entries need no hashes', async () => {
  const fetch = server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('snapshot')) return Response.json({ status: 'current', hashes: { source: digest(new Uint8Array([1])) } });
    return binary([1]);
  });
  await expect(new CacheEntry({ version: 'checked@1', dependencies: { source: { path: 'public/source.glb' } } }).load()).rejects.toThrow(/without its dependency hashes/);
  fetch.mockClear();
  expect(await new CacheEntry({ version: 'values@1', dependencies: { ratio: { value: 0.5 } } }).load()).toEqual(new Uint8Array([1]));
  // A deployed value-only hit costs one request: no discovery for a static host to answer with a logged 404.
  expect(fetch.mock.calls).toHaveLength(1);
});

test('plugin misses stay quiet', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('snapshot')) return Response.json({ status: 'current', hashes: {} });
    return new Response(null, { status: 204 });
  });
  expect(await new CacheEntry({ version: 'missing@1' }).has()).toBe(false);
  expect(await new CacheEntry({ version: 'missing@1', dependencies: { source: { path: 'source.ts' } } }).load()).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
});

test('a missing dependency misses without reading bytes, and rejects the save', async () => {
  server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(true);
    if (url.pathname.endsWith('snapshot')) return Response.json({ status: 'missing', message: 'Missing file or package dependency: source' });
    throw new Error('Must not read cached data for missing dependencies');
  });
  const missing = new CacheEntry({ version: 'missing-dep@1', dependencies: { source: { path: 'missing' } } });
  expect(await missing.load()).toBeUndefined();
  await expect(missing.save(new Uint8Array())).rejects.toThrow(/missing/);
});

test('a 409 on save is a ChangedDependenciesError', async () => {
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(true) : new Response(null, { status: 409 }));
  await expect(new CacheEntry({ version: 'failed@1' }).save(new Uint8Array())).rejects.toMatchObject({ name: 'ChangedDependenciesError' });
});

test('server, hosting and network failures reject without fallback', async () => {
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(true) : new Response(null, { status: 500 }));
  await expect(new CacheEntry({ version: 'broken@1' }).load()).rejects.toThrow('HTTP 500');
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
      expect(uploaded(init.body).metadata).toMatchObject({ expected: {} });
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

function productionServer() {
  return server((url) => {
    if (url.pathname.endsWith('__vitecache')) return discovery(false);
    if (url.pathname.endsWith('paths.json')) return Response.json({ root: '../../', paths: { 'assets/model-abc.glb': 'src/model.glb' } });
    return binary([7]);
  });
}

test('production URL resolution fetches the build mapping once and revalidates bytes', async () => {
  const fetch = productionServer();
  const options = { basePath: '/app/_vitecache/', dependencies: { model: { url: '/app/assets/model-abc.glb?v=1' } } };
  expect(await new CacheEntry({ ...options, version: 'production@1' }).load()).toEqual(new Uint8Array([7]));
  expect(await new CacheEntry({ ...options, version: 'production@2' }).load()).toEqual(new Uint8Array([7]));
  expect(fetch.mock.calls.filter(([url]) => url.toString().endsWith('paths.json'))).toHaveLength(1);
  // Entry names do not change with their contents, so the browser may keep the bytes but must revalidate them.
  expect(fetch.mock.calls.filter(([url]) => url.toString().endsWith('.bin')).every(([, init]) => init?.cache === 'no-cache')).toBe(true);
});

test('a URL the build did not map is a miss, like a missing file in development', async () => {
  productionServer();
  const unmapped = { version: 'unmapped@1', dependencies: { model: { url: '/unknown.glb' } } };
  expect(await new CacheEntry(unmapped).load()).toBeUndefined();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await new CacheEntry(unmapped).has()).toBe(false);
  expect(warn).toHaveBeenCalledOnce();
});

test('production URL resolution rejects foreign URLs and a missing build mapping', async () => {
  productionServer();
  await expect(new CacheEntry({ version: 'foreign@1', dependencies: { model: { url: 'https://foreign.test/a.glb' } } }).load()).rejects.toThrow(/same Vite project origin/);
  server((url) => url.pathname.endsWith('__vitecache') ? discovery(false) : new Response(null, { status: 404 }));
  await expect(new CacheEntry({ version: 'no-map@1', basePath: '/unbuilt/_vitecache/', dependencies: { model: { url: '/model.glb' } } }).load()).rejects.toThrow(/Missing production URL mapping/);
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
    if (url.pathname.endsWith('snapshot')) return Response.json({ status: 'current', hashes: { model: digest(new Uint8Array([1])) } });
    expect(url.pathname).toContain(key('lazy@1', { model: { path: 'public/model.glb' }, parameters: { value: { ratio: 0.5 } } }));
    return binary([2], { model: digest(new Uint8Array([1])) });
  });
  expect(fetch).not.toHaveBeenCalled();
  await expect(entry.load()).rejects.toThrow('HTTP 500');
  expect(await entry.load()).toEqual(new Uint8Array([2]));
  expect(attempts).toBe(2);
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
    new CacheEntry({ version: 'package@1', dependencies: { engine: { package: 'layout-engine' } } }),
  ];
  for (const entry of entries) await expect(entry.save(new Uint8Array([1]))).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.every(([url, init]) => url.toString().endsWith('__vitecache') && init?.method !== 'PUT')).toBe(true);
});
