import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { key, type CacheEntryOptions, type SaveOptions } from '../src/entry.js';
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

test('while the plugin warms, entries use its project and record their keys as loaded', async () => {
  const root = await project();
  const loaded = new Set<string>();
  vi.stubGlobal('vitecache', { root, publicDir: join(root, 'static'), loaded });
  const options = { version: 'warm@1' };
  await compute(options, [1]);
  expect(await readdir(join(root, 'static/_vitecache'))).toHaveLength(2);
  expect(loaded).toEqual(new Set([key(options)]));
  expect(publicURL('/tree/model.glts')).toBe(pathToFileURL(join(root, 'static/tree/model.glts')).href);
  const explicit = await project();
  await compute({ root: explicit, version: 'warm@1' }, [1]);
  expect(await readdir(join(explicit, 'public/_vitecache'))).toHaveLength(2);
});

test("without the plugin, publicURL maps a root-absolute path below the working directory's public", () => {
  const file = pathToFileURL(join(process.cwd(), 'public/tree/a b.glts')).href;
  expect(publicURL('/tree/a%20b.glts')).toBe(file);
  expect(publicURL('/tree/a%20b.glts?v=1#top')).toBe(file);
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

test('what an inline function imports is an input', async () => {
  const root = await project();
  await writeFile(join(root, 'weld.ts'), 'a');
  const transform = Object.defineProperty(() => 1, Symbol.for('vitecache.function'), {
    value: { id: 'f00d', inputs: [{ path: 'weld.ts' }] },
  });
  const options = { root, version: 'fn@1', dependencies: { transform: { value: transform } } };
  await compute(options, [1]);
  expect(await load(options)).toEqual(new Uint8Array([1]));
  await writeFile(join(root, 'weld.ts'), 'b');
  expect(await load(options)).toBeUndefined();
});
