import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import * as disk from '../src/disk.js';
import { contentHash } from '../src/hash.js';
import { CacheEntry } from '../src/node.js';
import type { CacheEntryOptions, SaveOptions } from '../src/types.js';

const roots: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vitecache-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Loads `options` as a computation would, then saves `bytes`. */
async function compute(options: CacheEntryOptions, bytes: number[], saveOptions?: SaveOptions): Promise<CacheEntry> {
  const entry = new CacheEntry(options);
  await entry.load();
  await entry.save(new Uint8Array(bytes), saveOptions);
  return entry;
}

const savedOptions = (root: string) => ({ root, version: 'saved@1', dependencies: { input: { value: 1 } } });

test('a save requires a load first, since the load records what the result is built from', async () => {
  const root = await project();
  await expect(new CacheEntry({ root, version: 'unloaded@1' }).save(new Uint8Array([1]))).rejects.toThrow(/load\(\) before/);
});

test('a dependency that changes during the computation makes the next load miss', async () => {
  const root = await project();
  await writeFile(join(root, 'source'), 'before');
  const entry = new CacheEntry({ root, version: 'race@1', dependencies: { source: { path: 'source' } } });
  expect(await entry.load()).toBeUndefined();
  await writeFile(join(root, 'source'), 'after');
  await entry.save(new Uint8Array([1]));
  expect(await entry.load()).toBeUndefined();
  await entry.save(new Uint8Array([2]));
  expect(await entry.load()).toEqual(new Uint8Array([2]));
});

test('a changed saved dependency misses', async () => {
  const root = await project();
  await writeFile(join(root, 'helper'), 'before');
  await installedPackage(root, 'compute', '1.0.0');
  await compute(savedOptions(root), [1], { dependencies: { helper: { url: pathToFileURL(join(root, 'helper')).href }, engine: { package: 'compute' } } });
  expect(await new CacheEntry(savedOptions(root)).load()).toEqual(new Uint8Array([1]));
  await writeFile(join(root, 'helper'), 'after');
  expect(await new CacheEntry(savedOptions(root)).load()).toBeUndefined();
});

test('a save with other saved dependencies replaces the same entry, and a removed one misses', async () => {
  const root = await project();
  await writeFile(join(root, 'helper'), 'helper');
  await writeFile(join(root, 'other'), 'other');
  const entry = await compute(savedOptions(root), [1], { dependencies: { helper: { path: 'helper' } } });
  await entry.save(new Uint8Array([2]), { dependencies: { other: { path: 'other' } } });
  expect(await new CacheEntry(savedOptions(root)).load()).toEqual(new Uint8Array([2]));
  expect(await readdir(join(root, 'public/_vitecache'))).toHaveLength(2);
  await unlink(join(root, 'other'));
  expect(await new CacheEntry(savedOptions(root)).load()).toBeUndefined();
});

test('a save rejects a missing saved dependency and a value one', async () => {
  const root = await project();
  const entry = new CacheEntry(savedOptions(root));
  await entry.load();
  await expect(entry.save(new Uint8Array([3]), { dependencies: { other: { path: 'other' } } })).rejects.toMatchObject({ name: 'MissingDependencyError' });
  // @ts-expect-error Values select the result and belong to the constructor.
  await expect(entry.save(new Uint8Array([3]), { dependencies: { setting: { value: 2 } } })).rejects.toThrow(TypeError);
});

test('persists the bytes save() was called with, and appends one ignore entry', async () => {
  const root = await project();
  await writeFile(join(root, '.gitignore'), 'node_modules');
  const options = { root, version: 'persist@1', dependencies: { model: { value: '模型' } } };
  const entry = new CacheEntry(options);
  expect(await entry.load()).toBeUndefined();
  const bytes = new Uint8Array([0, 255, 128]);
  const saving = entry.save(bytes);
  bytes.fill(42);
  await saving;
  expect(await new CacheEntry(options).load()).toEqual(new Uint8Array([0, 255, 128]));
  await entry.save(new Uint8Array());
  expect(await entry.load()).toEqual(new Uint8Array([]));
  expect(await readdir(join(root, 'public/_vitecache'))).toHaveLength(2);
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules\npublic/_vitecache/*\n');
});

test('validates file dependencies by content, even with a preserved mtime, and misses once one is gone', async () => {
  const root = await project();
  const source = join(root, 'model.bin');
  await writeFile(source, 'first');
  const timestamp = new Date('2024-01-01T00:00:00Z');
  await utimes(source, timestamp, timestamp);
  const options = { root, version: 'transform@1', dependencies: { model: { path: 'model.bin' } } };
  const entry = await compute(options, [1]);
  expect(await new CacheEntry(options).load()).toEqual(new Uint8Array([1]));
  await writeFile(source, 'other');
  await utimes(source, timestamp, timestamp);
  expect(await entry.load()).toBeUndefined();
  await unlink(source);
  expect(await entry.load()).toBeUndefined();
  await expect(entry.save(new Uint8Array([4]))).rejects.toMatchObject({ name: 'MissingDependencyError' });
});

test('hashes an unchanged dependency file once across entries, and again once it changes', async () => {
  const root = await project();
  const source = join(root, 'model.bin');
  await writeFile(source, 'first');
  const settled = new Date(Date.now() - 10_000);
  await utimes(source, settled, settled);
  const load = vi.spyOn(disk, 'load');
  const reads = () => load.mock.calls.filter(([path]) => path === source).length;
  const options = { root, version: 'shared@1', dependencies: { model: { path: 'model.bin' } } };
  const entry = new CacheEntry(options);
  expect(await Promise.all([entry.load(), new CacheEntry(options).load()])).toEqual([undefined, undefined]);
  await entry.save(new Uint8Array([1]));
  expect(await new CacheEntry(options).load()).toEqual(new Uint8Array([1]));
  expect(reads()).toBe(1);
  await writeFile(source, 'second');
  await utimes(source, settled, settled);
  expect(await new CacheEntry(options).load()).toBeUndefined();
  expect(reads()).toBe(2);
});

test('a hash taken just after a write is not reused, since a second write in the same mtime tick would go unseen', async () => {
  const root = await project();
  const source = join(root, 'model.bin');
  await writeFile(source, 'first');
  const load = vi.spyOn(disk, 'load');
  const options = { root, version: 'racy@1', dependencies: { model: { path: 'model.bin' } } };
  await new CacheEntry(options).load();
  await new CacheEntry(options).load();
  expect(load.mock.calls.filter(([path]) => path === source)).toHaveLength(2);
});

/** An entry saved under a custom basePath, with the paths of its bytes and metadata. */
async function savedEntry(): Promise<{ root: string; entry: CacheEntry; binary: string; metadata: string }> {
  const root = await project();
  const entry = await compute({ root, version: 'custom@1', basePath: 'generated/cache' }, [9]);
  const name = (await readdir(join(root, 'generated/cache'))).find((file) => file.endsWith('.bin'));
  if (!name) throw new Error('Expected cached bytes.');
  const binary = join(root, 'generated/cache', name);
  return { root, entry, binary, metadata: binary.replace(/\.bin$/, '.json') };
}

test('a custom basePath gets its own ignore entry', async () => {
  const { root } = await savedEntry();
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('generated/cache/*\n');
});

test('torn writes miss: bytes that do not match their metadata, or metadata that is gone', async () => {
  const { entry, binary, metadata } = await savedEntry();
  await writeFile(binary, new Uint8Array([8]));
  expect(await entry.load()).toBeUndefined();
  await unlink(metadata);
  expect(await entry.load()).toBeUndefined();
});

test('metadata an earlier version wrote misses, and malformed metadata is an error naming its file', async () => {
  const { entry, metadata } = await savedEntry();
  const hash = contentHash(new Uint8Array([9]));
  await writeFile(metadata, JSON.stringify({ contentHash: hash, dependencies: {}, saved: {}, savedHashes: {} }));
  expect(await entry.load()).toBeUndefined();
  await writeFile(metadata, '[');
  await expect(entry.load()).rejects.toThrow(`Invalid vitecache metadata: ${metadata}`);
  await writeFile(metadata, JSON.stringify({ contentHash: hash, inputs: [{ dependency: { value: 1 }, hash }] }));
  await expect(entry.load()).rejects.toThrow(expect.objectContaining({ name: 'Error', message: `Invalid vitecache metadata: ${metadata}` }));
});

test('a cache directory that cannot exist fails saves and loads visibly', async () => {
  const root = await project();
  await writeFile(join(root, 'blocked'), 'a file');
  const blocked = new CacheEntry({ root, version: 'blocked@1', basePath: 'blocked/cache' });
  await expect(blocked.load()).rejects.toThrow();
  await expect(blocked.save(new Uint8Array([9]))).rejects.toThrow();
});

test('concurrent saves append the ignore entry only once', async () => {
  const root = await project();
  await Promise.all(Array.from({ length: 8 }, (_, index) => compute({ root, version: `result@${index}` }, [index])));
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('public/_vitecache/*\n');
});

test('local file URLs resolve to the same dependency as project-relative paths', async () => {
  const root = await project();
  const source = join(root, 'source');
  await writeFile(source, 'source bytes');
  await compute({ root, version: 'url@1', dependencies: { source: { url: pathToFileURL(source).href } } }, [1]);
  expect(await new CacheEntry({ root, version: 'url@1', dependencies: { source: { path: 'source' } } }).load()).toEqual(new Uint8Array([1]));
  await expect(new CacheEntry({ root, version: 'url@1', dependencies: { source: { url: 'https://localhost/source' } } }).load()).rejects.toThrow(/project-root-relative path/);
  const outside = join(await project(), 'source');
  await writeFile(outside, 'outside');
  await expect(new CacheEntry({ root, version: 'url@1', dependencies: { source: { url: pathToFileURL(outside).href } } }).load()).rejects.toThrow(/project root/);
});

test('file URLs resolve through a symlinked project root without rewriting declared symlinks', async () => {
  const root = await project();
  const source = join(root, 'source');
  await writeFile(source, 'source');
  await symlink(source, join(root, 'source-link'));
  const linkedRoot = join(await project(), 'project');
  await symlink(root, linkedRoot, 'dir');
  const options = { root: linkedRoot, version: 'symlink@1' };
  await compute({ ...options, dependencies: { source: { url: pathToFileURL(await realpath(source)).href } } }, [1]);
  expect(await new CacheEntry({ ...options, dependencies: { source: { path: 'source' } } }).load()).toEqual(new Uint8Array([1]));
  await compute({ ...options, dependencies: { source: { url: pathToFileURL(join(linkedRoot, 'source-link')).href } } }, [2]);
  expect(await new CacheEntry({ ...options, dependencies: { source: { path: 'source-link' } } }).load()).toEqual(new Uint8Array([2]));
});

test('a loaded entry is a plain Uint8Array whose slice copies, so transferring a slice leaves it whole', async () => {
  const root = await project();
  const options = { root, version: 'owned@1', dependencies: { input: { value: 1 } } };
  await compute(options, [1, 2, 3, 4]);
  const bytes = await new CacheEntry(options).load();
  if (!bytes) throw new Error('Expected a cache hit');
  expect(Buffer.isBuffer(bytes)).toBe(false);
  expect(bytes.buffer.byteLength).toBe(4);
  const body = bytes.slice(1);
  structuredClone(body, { transfer: [body.buffer] });
  expect([...bytes]).toEqual([1, 2, 3, 4]);
});

async function installedPackage(root: string, name: string, version: string): Promise<string> {
  const directory = join(root, 'node_modules', name);
  await mkdir(directory, { recursive: true });
  const manifest = join(directory, 'package.json');
  await writeFile(manifest, JSON.stringify({ name, version, type: 'module', exports: { import: './index.js' } }));
  await writeFile(join(directory, 'index.js'), 'throw new Error("Must not execute the dependency");');
  return manifest;
}

test('package versions invalidate results, and a removed package misses', async () => {
  const root = await project();
  const manifest = await installedPackage(root, '@example/layout', '1.0.0');
  const options = { root, version: 'layout@1', dependencies: { engine: { package: '@example/layout' }, graph: { value: [1, 2] } } };
  const entry = await compute(options, [1]);
  expect(await new CacheEntry(options).load()).toEqual(new Uint8Array([1]));
  await writeFile(manifest, JSON.stringify({ version: '2.0.0' }));
  expect(await entry.load()).toBeUndefined();
  await unlink(manifest);
  expect(await entry.load()).toBeUndefined();
  await expect(entry.save(new Uint8Array([4]))).rejects.toMatchObject({ name: 'MissingDependencyError' });
});

test('package location and declaration order do not affect keys, and values select results', async () => {
  const root = await project();
  const packageRoot = await project();
  await installedPackage(packageRoot, 'layout', '1.0.0');
  await mkdir(join(root, 'node_modules'));
  await symlink(join(packageRoot, 'node_modules/layout'), join(root, 'node_modules/layout'), 'dir');
  await compute({ root, version: 'portable@1', dependencies: { graph: { value: { b: 2, a: 1 } }, engine: { package: 'layout' } } }, [1]);
  await unlink(join(root, 'node_modules/layout'));
  await installedPackage(root, 'layout', '1.0.0');
  const second = new CacheEntry({ root, version: 'portable@1', dependencies: { engine: { package: 'layout' }, graph: { value: { a: 1, b: 2 } } } });
  expect(await second.load()).toEqual(new Uint8Array([1]));
  await compute({ root, version: 'value@1', dependencies: { graph: { value: { nodes: [1] } } } }, [2]);
  expect(await new CacheEntry({ root, version: 'value@1', dependencies: { graph: { value: { nodes: [2] } } } }).load()).toBeUndefined();
});

test('a package resolves itself by name from its own root', async () => {
  const root = await project();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@example/self', version: '1.0.0' }));
  const entry = await compute({ root, version: 'self@1', dependencies: { engine: { package: '@example/self' } } }, [1]);
  expect(await entry.load()).toEqual(new Uint8Array([1]));
});

test('malformed package manifests remain visible rather than becoming cache misses', async () => {
  const root = await project();
  const manifest = await installedPackage(root, 'layout', '1.0.0');
  const entry = new CacheEntry({ root, version: 'layout@1', dependencies: { engine: { package: 'layout' } } });
  await writeFile(manifest, '{');
  await expect(entry.load()).rejects.toThrow(`Invalid package manifest: ${manifest}`);
  await writeFile(manifest, JSON.stringify({ version: 42 }));
  await expect(entry.load()).rejects.toThrow(/version/);
});
