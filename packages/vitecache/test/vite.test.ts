import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { build, createServer, preview } from 'vite';
import type { ViteDevServer } from 'vite';
import { CacheEntry as BrowserEntry } from '../src/browser.js';
import { CacheEntry as NodeEntry } from '../src/node.js';
import type { CacheEntryOptions, SaveOptions } from '../src/types.js';
import { vitecache } from '../src/vite/index.js';

const servers: ViteDevServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A dev server with the plugin, the page's location set to it. */
async function start(custom = false): Promise<{ root: string; origin: string; url: string; cache: string }> {
  const root = await mkdtemp(join(tmpdir(), 'vitecache-vite-'));
  roots.push(root);
  const server = await createServer({
    root,
    configFile: false,
    base: custom ? '/app/' : '/',
    publicDir: custom ? 'assets' : 'public',
    plugins: [vitecache(custom ? { basePath: 'assets/cache' } : {})],
    server: { host: '127.0.0.1', port: 0 },
  });
  servers.push(server);
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite server did not listen on TCP');
  const origin = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('location', { href: origin });
  return { root, origin, url: `${origin}${custom ? '/app/cache/' : '/_vitecache/'}`, cache: join(root, custom ? 'assets/cache' : 'public/_vitecache') };
}

async function compute(options: CacheEntryOptions, bytes: number[], saveOptions?: SaveOptions): Promise<void> {
  const entry = new NodeEntry(options);
  await entry.load();
  await entry.save(new Uint8Array(bytes), saveOptions);
}

/** The served URL of the only entry in `cache`. */
async function served(url: string, cache: string): Promise<string> {
  const name = (await readdir(cache)).find((file) => file.endsWith('.bin'));
  if (!name) throw new Error('Expected cached bytes.');
  return `${url}${name}`;
}

test.each([false, true])('serves what Node saved, and misses quietly, custom configuration %s', async (custom) => {
  const { root, url, cache } = await start(custom);
  expect(await (await fetch(`${url}__vitecache`)).json()).toEqual({ vitecache: 1 });
  expect((await fetch(`${url}${'0'.repeat(64)}.bin`)).status).toBe(204);
  await compute({ root, ...(custom ? { basePath: 'assets/cache' } : {}), version: 'served@1' }, [0, 255]);
  const response = await fetch(await served(url, cache));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/octet-stream');
  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
  expect(await new BrowserEntry({ version: 'served@1', basePath: url }).load()).toEqual(new Uint8Array([0, 255]));
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(custom ? 'assets/cache/*\n' : 'public/_vitecache/*\n');
});

test('revalidation answers 304 for the current tag only, and only while its bytes exist', async () => {
  const { root, url, cache } = await start();
  await compute({ root, version: 'tagged@1' }, [0]);
  const file = await served(url, cache);
  const tag = (await fetch(file)).headers.get('etag');
  if (tag === null) throw new Error('Expected an entity tag.');
  expect((await fetch(file, { headers: { 'If-None-Match': tag } })).status).toBe(304);
  expect((await fetch(file, { headers: { 'If-None-Match': '"other"' } })).status).toBe(200);
  await compute({ root, version: 'tagged@1' }, [1]);
  const replaced = await fetch(file, { headers: { 'If-None-Match': tag } });
  expect(replaced.status).toBe(200);
  expect(new Uint8Array(await replaced.arrayBuffer())).toEqual(new Uint8Array([1]));
  // Metadata left behind without its bytes no longer vouches for the bytes a browser holds.
  await unlink(file.replace(url, `${cache}/`));
  expect((await fetch(file, { headers: { 'If-None-Match': replaced.headers.get('etag') ?? '' } })).status).toBe(204);
});

test('browser and Node entries share keys, and the plugin serves an entry only while its inputs are current', async () => {
  const { root, url } = await start();
  const source = join(root, 'source.ts');
  const timestamp = new Date('2024-01-01');
  await writeFile(source, 'first');
  await utimes(source, timestamp, timestamp);
  await mkdir(join(root, 'node_modules/compute'), { recursive: true });
  const manifest = join(root, 'node_modules/compute/package.json');
  await writeFile(manifest, JSON.stringify({ name: 'compute', version: '1.0.0' }));
  await mkdir(join(root, 'public'), { recursive: true });
  await writeFile(join(root, 'public/helper.ts'), 'helper');
  const options = { version: 'cross-runtime@1', dependencies: { ratio: { value: 0.5 }, source: { path: 'source.ts' }, library: { package: 'compute' } } };
  const browser = new BrowserEntry({ ...options, basePath: url });
  expect(await browser.load()).toBeUndefined();
  await compute({ ...options, root }, [1, 255], { dependencies: { helper: { path: 'public/helper.ts' } } });
  expect(await browser.load()).toEqual(new Uint8Array([1, 255]));
  await writeFile(source, 'other');
  await utimes(source, timestamp, timestamp);
  expect(await browser.load()).toBeUndefined();
  await compute({ ...options, root }, [2], { dependencies: { helper: { path: 'public/helper.ts' } } });
  expect(await browser.load()).toEqual(new Uint8Array([2]));
  await writeFile(join(root, 'public/helper.ts'), 'changed');
  expect(await browser.load()).toBeUndefined();
  await compute({ ...options, root }, [3]);
  await writeFile(manifest, JSON.stringify({ name: 'compute', version: '2.0.0' }));
  expect(await browser.load()).toBeUndefined();
});

test('rejects writes, unknown files and cross-origin resolution', async () => {
  const { url } = await start();
  const file = `${url}${'0'.repeat(64)}.bin`;
  expect((await fetch(file, { method: 'PUT', body: 'bytes' })).status).toBe(405);
  expect((await fetch(`${url}unexpected.bin`)).status).toBe(404);
  expect((await fetch(`${file}%2fsecret`)).status).toBe(404);
  expect((await fetch(`${url}__vitecache/resolve`, {
    method: 'POST', headers: { Origin: 'https://attacker.example' }, body: JSON.stringify({ dependencies: {} }),
  })).status).toBe(403);
  expect((await fetch(`${url}__vitecache/resolve`, { method: 'POST', body: 'bad' })).status).toBe(400);
});

test.each([false, true])('resolves served URLs to project paths with custom configuration %s', async (custom) => {
  const { root, origin, url } = await start(custom);
  const publicDir = custom ? 'assets' : 'public';
  await mkdir(join(root, publicDir), { recursive: true });
  await writeFile(join(root, publicDir, 'chair.glb'), 'model');
  await writeFile(join(root, 'source.ts'), 'source');
  const resolve = async (dependencies: unknown) => fetch(`${url}__vitecache/resolve`, {
    method: 'POST', body: JSON.stringify({ dependencies }),
  });
  const prefix = custom ? '/app' : '';
  expect(await (await resolve({
    model: { url: `${origin}${prefix}/chair.glb?raw` },
    source: { url: `${prefix}/source.ts?t=123` },
    filesystem: { url: `${prefix}/@fs/${root}/source.ts` },
    same: { path: 'source.ts' },
    settings: { value: { ratio: 0.5 } },
    library: { package: 'compute' },
  })).json()).toEqual({ dependencies: { model: { path: `${publicDir}/chair.glb` }, source: { path: 'source.ts' }, filesystem: { path: 'source.ts' }, same: { path: 'source.ts' }, settings: { value: { ratio: 0.5 } }, library: { package: 'compute' } } });
  const named = await resolve(Object.fromEntries([['__proto__', { url: `${prefix}/source.ts` }]]));
  expect(await named.json()).toEqual({ dependencies: Object.fromEntries([['__proto__', { path: 'source.ts' }]]) });
  expect((await resolve({ model: { url: 'https://foreign.example/chair.glb' } })).status).toBe(400);
  const absent = await resolve({ model: { url: `${prefix}/absent.glb` } });
  expect(absent.status).toBe(200);
  expect(await absent.json()).toEqual({ status: 'missing', message: expect.stringContaining('absent.glb') });
});

test('refuses to resolve a URL to a file outside the root through a symlink', async () => {
  const { root, url } = await start();
  const outside = await mkdtemp(join(tmpdir(), 'vitecache-outside-'));
  roots.push(outside);
  await writeFile(join(outside, 'secret'), 'private');
  await mkdir(join(root, 'public'), { recursive: true });
  await symlink(join(outside, 'secret'), join(root, 'public/linked'));
  const response = await fetch(`${url}__vitecache/resolve`, { method: 'POST', body: JSON.stringify({ dependencies: { linked: { url: '/linked' } } }) });
  expect(response.status).toBe(403);
});

test('a browser entry with a URL dependency loads what Node saved for its file, and misses without one', async () => {
  const { root, url } = await start();
  const missing = new BrowserEntry({ version: 'url@1', basePath: url, dependencies: { input: { url: '/input.bin' } } });
  expect(await missing.load()).toBeUndefined();
  await mkdir(join(root, 'public'), { recursive: true });
  await writeFile(join(root, 'public/input.bin'), 'input');
  await compute({ root, version: 'url@1', dependencies: { input: { path: 'public/input.bin' } } }, [4]);
  expect(await missing.load()).toEqual(new Uint8Array([4]));
});

test.each(['/app/', './'])('build preserves public and emitted URL mappings with base %s', async (base) => {
  const cachePath = base === './' ? 'nested/cache' : 'cache';
  const prefix = base === './' ? '' : '/app';
  const root = await mkdtemp(join(tmpdir(), 'vitecache-build-'));
  roots.push(root);
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<script type="module" src="/src/main.js"></script>');
  await writeFile(join(root, 'src/main.js'), 'import model from "./chair.glb?url"; console.log(model)');
  await writeFile(join(root, 'src/chair.glb'), 'imported model');
  await writeFile(join(root, 'assets/public.glb'), 'public model');
  await mkdir(join(root, 'node_modules/compute'), { recursive: true });
  await writeFile(join(root, 'node_modules/compute/package.json'), JSON.stringify({ name: 'compute', version: '1.0.0' }));
  await build({ root, base, publicDir: 'assets', configFile: false, logLevel: 'silent',
    plugins: [vitecache({ basePath: `assets/${cachePath}` })], build: { assetsInlineLimit: 0 },
  });
  const raw: unknown = JSON.parse(await readFile(join(root, `dist/${cachePath}/__vitecache/paths.json`), 'utf8'));
  if (typeof raw !== 'object' || raw === null || !('paths' in raw) || typeof raw.paths !== 'object' || raw.paths === null) {
    throw new Error('Invalid manifest');
  }
  expect(raw.paths).toMatchObject({ 'public.glb': 'assets/public.glb' });
  expect(raw).toHaveProperty('root', base === './' ? '../../../' : '../../');
  const emitted = Object.entries(raw.paths).find(([, path]) => path === 'src/chair.glb');
  expect(emitted?.[0]).toMatch(/^assets\/chair-[^/]+\.glb$/);
  if (!emitted) throw new Error('Missing emitted asset mapping');
  const server = await preview({ root, base, configFile: false, logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } });
  try {
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Preview did not listen');
    const origin = `http://127.0.0.1:${address.port}`;
    vi.stubGlobal('location', { href: `${origin}${prefix}/` });
    await compute({ root, basePath: `dist/${cachePath}`, version: 'build@1', dependencies: { model: { path: 'src/chair.glb' }, library: { package: 'compute' }, settings: { value: { ratio: 0.5 } } } }, [42]);
    const browser = new BrowserEntry({ basePath: `${origin}${prefix}/${cachePath}/`, version: 'build@1', dependencies: { model: { url: `${prefix}/${emitted[0]}` }, library: { package: 'compute' }, settings: { value: { ratio: 0.5 } } } });
    expect(await browser.load()).toEqual(new Uint8Array([42]));
  } finally {
    await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
  }
});
