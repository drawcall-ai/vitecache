import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { build, createServer, preview } from 'vite';
import type { ViteDevServer } from 'vite';
import { CacheEntry as BrowserEntry } from '../src/browser.js';
import { CacheEntry as NodeEntry } from '../src/node.js';
import { createStorage } from '../src/storage.js';
import { digest } from '../src/key.js';
import { vitecache } from '../src/vite/index.js';

const servers: ViteDevServer[] = [];
const roots: string[] = [];
afterEach(async () => {
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
const files = { '算法': '算法.ts' };

async function snapshot(url: string, fileDependencies: Record<string, string> = files): Promise<Response> {
  return fetch(`${url}__vitecache/snapshot`, {
    method: 'POST',
    body: JSON.stringify({ fileDependencies }),
  });
}

function headers(source: string): Record<string, string> {
  return {
    'X-Vitecache-Dependencies': encodeURIComponent(JSON.stringify(files)),
    'X-Vitecache-Hashes': encodeURIComponent(JSON.stringify({ '算法': digest(new TextEncoder().encode(source)) })),
  };
}

test.each([false, true])('persists dependency metadata and bytes with custom configuration %s', async (custom) => {
  const { root, origin, url } = await start(custom);
  await writeFile(join(root, files['算法']), 'before');
  expect(await (await fetch(`${url}__vitecache`)).json()).toEqual({ vitecache: 1 });
  expect(await (await snapshot(url)).json()).toEqual({ hashes: { '算法': digest(new TextEncoder().encode('before')) } });
  const file = `${url}${key}.bin`;
  expect((await fetch(file)).status).toBe(404);
  const saved = await fetch(file, {
    method: 'PUT',
    headers: { Origin: origin, ...headers('before') },
    body: new Uint8Array([0, 255]),
  });
  expect(saved.status).toBe(204);
  const head = await fetch(file, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-type')).toBe('application/octet-stream');
  expect(head.headers.get('x-vitecache-dependencies')).toBe(headers('before')['X-Vitecache-Hashes']);
  expect(new Uint8Array(await (await fetch(file)).arrayBuffer())).toEqual(new Uint8Array([0, 255]));
  const options = custom ? { root, basePath: 'assets/cache' } : { root };
  expect((await createStorage(options).load(key, true))?.bytes).toEqual(Buffer.from([0, 255]));
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(custom ? 'assets/cache/*\n' : 'public/_vitecache/*\n');
  await writeFile(join(root, files['算法']), 'after');
  expect((await fetch(file, { method: 'PUT', headers: headers('before'), body: 'stale' })).status).toBe(409);
  expect(await (await snapshot(url, { absent: 'absent.ts' })).json()).toEqual({ hashes: null });
});

test('rejects malformed protocol, foreign origins, and dependency paths outside the root', async () => {
  const { root, url } = await start();
  const file = `${url}${key}.bin`;
  expect((await fetch(file, { method: 'PUT', headers: { Origin: 'https://attacker.example' }, body: 'bad' })).status).toBe(403);
  expect((await fetch(file, { method: 'PUT', body: 'bad' })).status).toBe(400);
  expect((await fetch(`${url}__vitecache/snapshot`, {
    method: 'POST', headers: { Origin: 'https://attacker.example' }, body: JSON.stringify({ fileDependencies: {} }),
  })).status).toBe(403);
  expect((await snapshot(url, { outside: '../outside' })).status).toBe(400);
  const outside = await mkdtemp(join(tmpdir(), 'vitecache-outside-'));
  roots.push(outside);
  await writeFile(join(outside, 'secret'), 'private');
  await symlink(join(outside, 'secret'), join(root, 'linked'));
  expect((await snapshot(url, { linked: 'linked' })).status).toBe(403);
  expect((await fetch(`${url}unexpected.bin`, { method: 'PUT', body: 'bad' })).status).toBe(404);
  expect((await fetch(`${file}%2fsecret`)).status).toBe(404);
  expect((await fetch(file, { method: 'DELETE' })).status).toBe(405);
});


test('browser CacheEntry and Node CacheEntry share identity, validate, and persist through the live plugin', async () => {
  const { root, origin, url } = await start();
  vi.stubGlobal('location', { href: origin });
  const source = join(root, 'source.ts');
  await writeFile(source, 'first');
  const options = { version: 'cross-runtime@1', inputs: { ratio: 0.5 }, fileDependencies: { source: { path: 'source.ts' } } };
  const browser = new BrowserEntry({ ...options, basePath: url });
  const node = new NodeEntry({ ...options, root });
  expect(await browser.load()).toBeUndefined();
  await browser.save(new Uint8Array([1, 255]));
  expect(await node.load()).toEqual(Buffer.from([1, 255]));
  await writeFile(source, 'second');
  expect(await browser.load()).toBeUndefined();
  await browser.save(new Uint8Array([2]));
  expect(await new NodeEntry({ ...options, root }).load()).toEqual(Buffer.from([2]));
});


test.each([false, true])('resolves served URLs to project paths with custom configuration %s', async (custom) => {
  const { root, origin, url } = await start(custom);
  const publicDir = custom ? 'assets' : 'public';
  await mkdir(join(root, publicDir), { recursive: true });
  await writeFile(join(root, publicDir, 'chair.glb'), 'model');
  await writeFile(join(root, 'source.ts'), 'source');
  const resolve = async (fileDependencies: unknown) => fetch(`${url}__vitecache/resolve`, {
    method: 'POST', body: JSON.stringify({ fileDependencies }),
  });
  const prefix = custom ? '/app' : '';
  expect(await (await resolve({
    model: { url: `${origin}${prefix}/chair.glb?raw` },
    source: { url: `${prefix}/source.ts?t=123` },
    filesystem: { url: `${prefix}/@fs/${root}/source.ts` },
    same: { path: 'source.ts' },
  })).json()).toEqual({ paths: { model: `${publicDir}/chair.glb`, source: 'source.ts', filesystem: 'source.ts', same: 'source.ts' } });
  const named = await resolve(Object.fromEntries([['__proto__', { url: `${prefix}/source.ts` }]]));
  expect(await named.json()).toEqual({ paths: Object.fromEntries([['__proto__', 'source.ts']]) });
  expect((await resolve({ model: { url: 'https://foreign.example/chair.glb' } })).status).toBe(400);
  expect((await resolve({ model: { url: `${prefix}/absent.glb` } })).status).toBe(400);
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
    const node = new NodeEntry({ root, basePath: `dist/${cachePath}`, version: 'build@1', fileDependencies: { model: { path: 'src/chair.glb' } } });
    await node.load();
    await node.save(new Uint8Array([42]));
    const browser = new BrowserEntry({ basePath: `${origin}${prefix}/${cachePath}/`, version: 'build@1', fileDependencies: { model: { url: `${prefix}/${emitted[0]}` } } });
    expect(await browser.load()).toEqual(new Uint8Array([42]));
  } finally {
    await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
  }
});
