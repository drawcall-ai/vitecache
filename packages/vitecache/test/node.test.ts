import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { CacheEntryOptions, SaveOptions } from '../src/entry.js';
import { CacheEntry } from '../src/node.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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

test('save requires a load first and inputs that exist', async () => {
  const root = await project();
  await expect(new CacheEntry({ root, version: 'unloaded@1' }).save(new Uint8Array([1]))).rejects.toThrow(
    /load\(\) before/,
  );
  await expect(
    compute({ root, version: 'missing@1', dependencies: { source: { path: 'missing.txt' } } }, [1]),
  ).rejects.toThrow(/no file/);
});

test('loads after an earlier vitecache version in the process left its own shared state', async () => {
  const root = await project();
  vi.stubGlobal('vitecache', { loaded: new Set(), saved: new Set() });
  vi.resetModules();
  const { CacheEntry: Fresh } = await import('../src/node.js');
  expect(await new Fresh({ root, version: 'restart@1' }).load()).toBeUndefined();
  vi.unstubAllGlobals();
});
