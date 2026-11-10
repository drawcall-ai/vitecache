import { mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { build, createServer, preview } from 'vite';
import type { ViteDevServer } from 'vite';
import { CacheEntry as BrowserEntry } from '../src/browser.js';
import { CacheEntry as NodeEntry } from '../src/node.js';
import { createStorage } from '../src/storage.js';
import { ChangedDependenciesError, MissingDependencyError } from '../src/dependencies.js';
import { digest } from '../src/key.js';
import type { Dependencies, Resolved } from '../src/types.js';
import { vitecache } from '../src/vite/index.js';

const servers: ViteDevServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function start(custom = false): Promise<{ root: string; origin: string; url: string }> {
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
  return { root, origin, url: `${origin}${custom ? '/app/cache/' : '/_vitecache/'}` };
}

const key = digest(new TextEncoder().encode('result'));
const files = { '算法': { path: '算法.ts' } };

async function snapshot(url: string, dependencies: Dependencies<Resolved> = files): Promise<Response> {
  return fetch(`${url}__vitecache/snapshot`, {
    method: 'POST',
    body: JSON.stringify({ dependencies }),
  });
}

const hashes = (source: string) => ({ '算法': digest(new TextEncoder().encode(source)) });

/** A save body for `files` hashed from `source`: length-prefixed JSON metadata, then the bytes. */
function upload(source: string, bytes: Uint8Array, saved: Dependencies<Resolved> = {}): Uint8Array<ArrayBuffer> {
  const metadata = new TextEncoder().encode(JSON.stringify({ checked: files, expected: hashes(source), saved }));
  const body = new Uint8Array(4 + metadata.byteLength + bytes.byteLength);
  new DataView(body.buffer).setUint32(0, metadata.byteLength);
  body.set(metadata, 4);
  body.set(bytes, 4 + metadata.byteLength);
  return body;
}

/** A plugin server holding one entry saved from `files` with contents "before". */
async function startSaved(): Promise<{ root: string; url: string; file: string }> {
  const { root, url } = await start();
  await writeFile(join(root, files['算法'].path), 'before');
  const file = `${url}${key}.bin`;
  expect((await fetch(file, { method: 'PUT', body: upload('before', new Uint8Array([0, 255])) })).status).toBe(204);
  return { root, url, file };
}

test.each([false, true])('saves an entry and serves it with its dependency hashes, custom configuration %s', async (custom) => {
  const { root, origin, url } = await start(custom);
  await writeFile(join(root, files['算法'].path), 'before');
  expect(await (await fetch(`${url}__vitecache`)).json()).toEqual({ vitecache: 1 });
  expect(await (await snapshot(url)).json()).toEqual({ status: 'current', hashes: hashes('before') });
  const file = `${url}${key}.bin`;
  expect((await fetch(file)).status).toBe(204);
  expect((await fetch(file, { method: 'PUT', headers: { Origin: origin }, body: upload('before', new Uint8Array([0, 255])) })).status).toBe(204);
  const first = await fetch(file);
  expect(first.status).toBe(200);
  expect(first.headers.get('content-type')).toBe('application/octet-stream');
  expect(first.headers.get('x-vitecache-dependencies')).toBe(encodeURIComponent(JSON.stringify(hashes('before'))));
  expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
  expect(first.headers.get('cache-control')).toBe('no-cache');
  const options = custom ? { root, basePath: 'assets/cache' } : { root };
  expect((await createStorage(options).load(key))?.bytes).toEqual(new Uint8Array([0, 255]));
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(custom ? 'assets/cache/*\n' : 'public/_vitecache/*\n');
});

test('revalidation answers 304 for the current tag only, and only while its bytes exist', async () => {
  const { root, file } = await startSaved();
  const tag = (await fetch(file)).headers.get('etag');
  if (tag === null) throw new Error('Expected an entity tag.');
  const unchanged = await fetch(file, { headers: { 'If-None-Match': tag } });
  expect(unchanged.status).toBe(304);
  expect(unchanged.headers.get('x-vitecache-dependencies')).toBe(encodeURIComponent(JSON.stringify(hashes('before'))));
  expect((await fetch(file, { headers: { 'If-None-Match': '"other"' } })).status).toBe(200);
  await fetch(file, { method: 'PUT', body: upload('before', new Uint8Array([1])) });
  const replaced = await fetch(file, { headers: { 'If-None-Match': tag } });
  expect(replaced.status).toBe(200);
  expect(new Uint8Array(await replaced.arrayBuffer())).toEqual(new Uint8Array([1]));
  // Metadata left behind without its bytes no longer vouches for the bytes a browser holds.
  await unlink(join(root, 'public/_vitecache', `${key}.bin`));
  expect((await fetch(file, { headers: { 'If-None-Match': replaced.headers.get('etag') ?? '' } })).status).toBe(204);
});

test('a save after its dependencies changed answers 409, and a snapshot reports a missing dependency', async () => {
  const { root, url, file } = await startSaved();
  await writeFile(join(root, files['算法'].path), 'after');
  expect((await fetch(file, { method: 'PUT', body: upload('before', new Uint8Array([1])) })).status).toBe(409);
  expect(await (await snapshot(url, { absent: { path: 'absent.ts' } })).json()).toEqual({ status: 'missing', message: expect.any(String) });
});

test('rejects cross-origin writes and snapshots', async () => {
  const { url } = await start();
  expect((await fetch(`${url}${key}.bin`, { method: 'PUT', headers: { Origin: 'https://attacker.example' }, body: 'bad' })).status).toBe(403);
  expect((await fetch(`${url}__vitecache/snapshot`, {
    method: 'POST', headers: { Origin: 'https://attacker.example' }, body: JSON.stringify({ dependencies: {} }),
  })).status).toBe(403);
});

test('rejects malformed requests, value saved dependencies, unknown files and methods', async () => {
  const { root, url } = await start();
  const file = `${url}${key}.bin`;
  await writeFile(join(root, files['算法'].path), 'source');
  expect((await fetch(file, { method: 'PUT', body: 'bad' })).status).toBe(400);
  expect((await fetch(file, { method: 'PUT', body: upload('source', new Uint8Array([1]), { setting: { value: 1 } }) })).status).toBe(400);
  expect((await fetch(`${url}unexpected.bin`, { method: 'PUT', body: 'bad' })).status).toBe(404);
  expect((await fetch(`${file}%2fsecret`)).status).toBe(404);
  expect((await fetch(file, { method: 'DELETE' })).status).toBe(405);
});

test('rejects dependency paths outside the root, also through a symlink', async () => {
  const { root, url } = await start();
  expect((await snapshot(url, { outside: { path: '../outside' } })).status).toBe(400);
  const outside = await mkdtemp(join(tmpdir(), 'vitecache-outside-'));
  roots.push(outside);
  await writeFile(join(outside, 'secret'), 'private');
  await symlink(join(outside, 'secret'), join(root, 'linked'));
  expect((await snapshot(url, { linked: { path: 'linked' } })).status).toBe(403);
  await writeFile(join(root, files['算法'].path), 'source');
  expect((await fetch(`${url}${key}.bin`, { method: 'PUT', body: upload('source', new Uint8Array([1]), { linked: { path: 'linked' } }) })).status).toBe(403);
});

test('browser CacheEntry and Node CacheEntry share identity, validate, and persist through the live plugin', async () => {
  const { root, origin, url } = await start();
  vi.stubGlobal('location', { href: origin });
  const source = join(root, 'source.ts');
  const timestamp = new Date('2024-01-01');
  await writeFile(source, 'first');
  await utimes(source, timestamp, timestamp);
  await mkdir(join(root, 'node_modules/compute'), { recursive: true });
  const manifest = join(root, 'node_modules/compute/package.json');
  await writeFile(manifest, JSON.stringify({ name: 'compute', version: '1.0.0' }));
  const options = { version: 'cross-runtime@1', dependencies: { ratio: { value: 0.5 }, source: { path: 'source.ts' }, library: { package: 'compute' } } };
  const browser = new BrowserEntry({ ...options, basePath: url });
  const node = new NodeEntry({ ...options, root });
  expect(await browser.load()).toBeUndefined();
  await browser.save(new Uint8Array([1, 255]));
  expect(await node.load()).toEqual(new Uint8Array([1, 255]));
  const stale = new BrowserEntry({ ...options, version: 'stale@1', basePath: url });
  expect(await stale.load()).toBeUndefined();
  await writeFile(source, 'other');
  await utimes(source, timestamp, timestamp);
  expect(await browser.load()).toBeUndefined();
  await expect(stale.save(new Uint8Array([9]))).rejects.toThrow(ChangedDependenciesError);
  await browser.save(new Uint8Array([2]));
  expect(await new NodeEntry({ ...options, root }).load()).toEqual(new Uint8Array([2]));
  await writeFile(manifest, JSON.stringify({ name: 'compute', version: '2.0.0' }));
  expect(await browser.load()).toBeUndefined();
  await browser.save(new Uint8Array([3]));
  expect(await new NodeEntry({ ...options, root }).load()).toEqual(new Uint8Array([3]));
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

test('a missing URL-backed dependency misses, and saved URL dependencies validate loads through the live plugin', async () => {
  const { root, origin, url } = await start();
  vi.stubGlobal('location', { href: origin });
  const missing = new BrowserEntry({ version: 'missing-url@1', basePath: url, dependencies: { input: { url: '/input.bin' } } });
  expect(await missing.load()).toBeUndefined();
  expect(await missing.has()).toBe(false);
  await expect(missing.save(new Uint8Array([1]))).rejects.toThrow(MissingDependencyError);

  await mkdir(join(root, 'public'), { recursive: true });
  await writeFile(join(root, 'public/helper.ts'), 'before');
  const options = { version: 'saved@1', basePath: url };
  await new BrowserEntry(options).save(new Uint8Array([1]), { dependencies: { helper: { url: '/helper.ts' } } });
  expect(await new BrowserEntry(options).load()).toEqual(new Uint8Array([1]));
  await writeFile(join(root, 'public/helper.ts'), 'after');
  expect(await new BrowserEntry(options).load()).toBeUndefined();
  await new BrowserEntry(options).save(new Uint8Array([2]), { dependencies: { helper: { url: '/helper.ts' } } });
  expect(await new BrowserEntry(options).load()).toEqual(new Uint8Array([2]));
  await rm(join(root, 'public/helper.ts'));
  expect(await new BrowserEntry(options).load()).toBeUndefined();
  await expect(new BrowserEntry(options).save(new Uint8Array([3]), { dependencies: { helper: { path: 'public/helper.ts' } } })).rejects.toThrow(MissingDependencyError);
});

test('saves hundreds of saved dependencies through the live plugin', async () => {
  const { root, origin, url } = await start();
  vi.stubGlobal('location', { href: origin });
  const directory = join(root, 'public/textures/a-long-directory-name-like-real-asset-paths');
  await mkdir(directory, { recursive: true });
  const names = Array.from({ length: 500 }, (_, index) => `texture-${index}-diffuse.webp`);
  await Promise.all(names.map((name) => writeFile(join(directory, name), name)));
  const dependencies = Object.fromEntries(names.map((name, index) => [`resource:${index}`, { url: `/textures/a-long-directory-name-like-real-asset-paths/${name}` }]));
  const options = { version: 'many@1', basePath: url };
  await new BrowserEntry(options).save(new Uint8Array([1]), { dependencies });
  expect(await new BrowserEntry(options).load()).toEqual(new Uint8Array([1]));
  await writeFile(join(directory, 'texture-499-diffuse.webp'), 'changed');
  expect(await new BrowserEntry(options).load()).toBeUndefined();
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
    const node = new NodeEntry({ root, basePath: `dist/${cachePath}`, version: 'build@1', dependencies: { model: { path: 'src/chair.glb' }, library: { package: 'compute' }, settings: { value: { ratio: 0.5 } } } });
    await node.load();
    await node.save(new Uint8Array([42]));
    const browser = new BrowserEntry({ basePath: `${origin}${prefix}/${cachePath}/`, version: 'build@1', dependencies: { model: { url: `${prefix}/${emitted[0]}` }, library: { package: 'compute' }, settings: { value: { ratio: 0.5 } } } });
    expect(await browser.load()).toEqual(new Uint8Array([42]));
  } finally {
    await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
  }
});
