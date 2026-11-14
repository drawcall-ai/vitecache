import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { key, type CacheEntryOptions, type SaveOptions } from '../src/entry.js';
import type { Warming } from '../src/disk.js';
import { CacheEntry, publicURL } from '../src/node.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vitecache-'));
  roots.push(root);
  return root;
}

async function compute(options: CacheEntryOptions, bytes: number[], saveOptions?: SaveOptions): Promise<void> {
  const entry = new CacheEntry(options);
  await entry.load();
  await entry.save(new Uint8Array(bytes), saveOptions);
}

const load = (options: CacheEntryOptions) => new CacheEntry(options).load();

test('a hit lasts while its file and package inputs are unchanged', async () => {
  const root = await project();
  await writeFile(join(root, 'source.txt'), 'a');
  await mkdir(join(root, 'node_modules/engine'), { recursive: true });
  await writeFile(join(root, 'node_modules/engine/package.json'), '{ "version": "1.0.0" }');
  const options = {
    root,
    version: 'inputs@1',
    dependencies: { source: { path: 'source.txt' }, engine: { package: 'engine' } },
  };
  await compute(options, [1, 2]);
  expect(await load(options)).toEqual(new Uint8Array([1, 2]));
  await writeFile(join(root, 'node_modules/engine/package.json'), '{ "version": "1.0.1" }');
  expect(await load(options)).toBeUndefined();
  await compute(options, [3]);
  await writeFile(join(root, 'source.txt'), 'b');
  expect(await load(options)).toBeUndefined();
});

test('an input that changes during the computation makes the next load miss', async () => {
  const root = await project();
  await writeFile(join(root, 'source.txt'), 'before');
  const entry = new CacheEntry({ root, version: 'race@1', dependencies: { source: { path: 'source.txt' } } });
  await entry.load();
  await writeFile(join(root, 'source.txt'), 'after');
  await entry.save(new Uint8Array([1]));
  expect(await entry.load()).toBeUndefined();
});

test('inputs passed to save are checked without changing the key', async () => {
  const root = await project();
  await writeFile(join(root, 'texture.png'), 'a');
  const options = { root, version: 'bake@1' };
  await compute(options, [1], { dependencies: [{ path: 'texture.png' }] });
  expect(await load(options)).toEqual(new Uint8Array([1]));
  await writeFile(join(root, 'texture.png'), 'b');
  expect(await load(options)).toBeUndefined();
});

test('a file: URL input invalidates like a path, and is saved as one', async () => {
  const root = await project();
  await writeFile(join(root, 'model.glts'), 'a');
  const options = { root, version: 'url@1' };
  await compute(options, [1], { dependencies: [{ path: pathToFileURL(join(root, 'model.glts')).href }] });
  const metadata = await readFile(join(root, 'public/_vitecache', `${key(options)}.json`), 'utf8');
  expect(metadata).toContain('{"path":"model.glts"}');
  expect(await load(options)).toEqual(new Uint8Array([1]));
  await writeFile(join(root, 'model.glts'), 'b');
  expect(await load(options)).toBeUndefined();
});

/** The global the plugin sets, for a project whose publicDir is `static`. */
const plugin = (root: string) => ({
  root,
  publicDir: join(root, 'static'),
  loaded: new Set<string>(),
  warming: new AsyncLocalStorage<Warming>(),
});

test('while the plugin warms, entries use its project and record their keys as loaded', async () => {
  const root = await project();
  const global = plugin(root);
  vi.stubGlobal('vitecache', global);
  const options = { version: 'warm@1' };
  await compute(options, [1]);
  expect(await readdir(join(root, 'static/_vitecache'))).toHaveLength(2);
  expect(global.loaded).toEqual(new Set([key(options)]));
  const explicit = await project();
  await compute({ root: explicit, version: 'warm@1' }, [1]);
  expect(await readdir(join(explicit, 'public/_vitecache'))).toHaveLength(2);
});

test('a load the plugin warms records the modules it ran and the public files publicURL gave it', async () => {
  const root = await project();
  const global = plugin(root);
  vi.stubGlobal('vitecache', global);
  await mkdir(join(root, 'static/tree'), { recursive: true });
  await writeFile(join(root, 'static/tree/a b.bin'), new Uint8Array([7]));
  await writeFile(join(root, 'weld.ts'), 'a');
  const three = 'node_modules/.pnpm/three@1/node_modules/three/package.json';
  await mkdir(join(root, dirname(three)), { recursive: true });
  await writeFile(join(root, three), '{ "version": "1.0.0" }');
  const modules = () => [join(root, 'weld.ts'), join(root, three)];
  const options = { root, version: 'used@1' };
  await global.warming.run({ files: new Set(), modules }, async () => {
    const entry = new CacheEntry(options);
    await entry.load();
    // A data: URL, since Node fetches no file: URLs, without the path's query and hash.
    const response = await fetch(publicURL('/tree/a%20b.bin?v=1#top'));
    await entry.save(new Uint8Array(await response.arrayBuffer()));
  });
  const [metadata = ''] = (await readdir(join(root, 'public/_vitecache'))).filter((file) => file.endsWith('.json'));
  const { inputs } = JSON.parse(await readFile(join(root, 'public/_vitecache', metadata), 'utf8'));
  expect(inputs.map((input: { dependency: object }) => input.dependency)).toEqual([
    { path: 'weld.ts' },
    { path: three },
    { path: 'static/tree/a b.bin' },
  ]);
});

test('publicURL maps only root-absolute paths, and those only below publicDir', () => {
  for (const url of ['tree/model.glts', './model.glts', '//cdn.test/model.glts', 'https://cdn.test/model.glts'])
    expect(publicURL(url)).toBe(url);
  for (const url of ['/../x', '/tree/%2e%2e/../x']) expect(() => publicURL(url)).toThrow(/outside publicDir/);
});

test('a file: URL among the declared dependencies is refused, since it belongs on save()', () => {
  const dependencies = { model: { path: pathToFileURL('/model.glts').href } };
  expect(() => new CacheEntry({ version: 'url@1', dependencies })).toThrow(/Pass it to save\(\)/);
});

test('save requires a load first and inputs that exist', async () => {
  const root = await project();
  await expect(new CacheEntry({ root, version: 'unloaded@1' }).save(new Uint8Array([1]))).rejects.toThrow(
    /load\(\) before/,
  );
  await expect(
    compute({ root, version: 'missing@1', dependencies: { source: { path: 'missing.txt' } } }, [1]),
  ).rejects.toThrow(/no file/);
});
