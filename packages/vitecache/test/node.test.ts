import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import * as disk from '../src/disk.js';
import { digest, key } from '../src/key.js';
import { CacheEntry } from '../src/node.js';
import { createStorage } from '../src/storage.js';

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

test('saved dependencies validate a result without entering its key', async () => {
  const root = await project();
  await writeFile(join(root, 'helper'), 'before');
  await writeFile(join(root, 'other'), 'other');
  await installedPackage(root, 'compute', '1.0.0');
  const options = { root, version: 'saved@1', dependencies: { input: { value: 1 } } };
  const entry = new CacheEntry(options);
  await entry.save(new Uint8Array([1]), { dependencies: { helper: { url: pathToFileURL(join(root, 'helper')).href }, engine: { package: 'compute' } } });
  expect(await new CacheEntry(options).load()).toEqual(Buffer.from([1]));
  await writeFile(join(root, 'helper'), 'after');
  expect(await new CacheEntry(options).load()).toBeUndefined();

  await entry.save(new Uint8Array([2]), { dependencies: { other: { path: 'other' } } });
  expect(await new CacheEntry(options).load()).toEqual(Buffer.from([2]));
  expect(await readdir(join(root, 'public/_vitecache'))).toHaveLength(2);
  await unlink(join(root, 'other'));
  expect(await new CacheEntry(options).has()).toBe(false);
  await expect(entry.save(new Uint8Array([3]), { dependencies: { other: { path: 'other' } } })).rejects.toThrow(/missing/);
  // @ts-expect-error Values select the result and belong to the constructor.
  await expect(entry.save(new Uint8Array([3]), { dependencies: { setting: { value: 2 } } })).rejects.toThrow(TypeError);
});

test('a dependency change while staging bytes does not publish the rejected result', async () => {
  const root = await project();
  const source = join(root, 'source');
  await writeFile(source, 'before');
  const entry = new CacheEntry({ root, version: 'race@1', dependencies: { source: { path: 'source' } } });
  await entry.load();
  await entry.save(new Uint8Array([1]));
  await entry.load();
  const save = disk.save;
  vi.spyOn(disk, 'save').mockImplementation(async (path, bytes, beforeCommit) => {
    if (path.endsWith('.bin')) await writeFile(source, 'after');
    await save(path, bytes, beforeCommit);
  });
  await expect(entry.save(new Uint8Array([2]))).rejects.toThrow(/changed/);
  const files = await readdir(join(root, 'public/_vitecache'));
  const binary = files.find((file) => file.endsWith('.bin'));
  if (!binary) throw new Error('Expected cached bytes.');
  expect(await readFile(join(root, 'public/_vitecache', binary))).toEqual(Buffer.from([1]));
  expect(files).toEqual([binary, binary.replace(/\.bin$/, '.json')]);
});

test('repeated validity checks cannot replace a computation baseline', async () => {
  const root = await project();
  const source = join(root, 'source');
  await writeFile(source, 'before');
  const entry = new CacheEntry({ root, version: 'baseline@1', dependencies: { source: { path: 'source' } } });
  expect(await entry.load()).toBeUndefined();
  await writeFile(source, 'after');
  expect(await entry.has()).toBe(false);
  await expect(entry.save(new Uint8Array([1]))).rejects.toThrow(/changed/);
  expect(await entry.load()).toBeUndefined();
  await entry.save(new Uint8Array([2]));
  expect(await entry.load()).toEqual(Buffer.from([2]));
});

test('a hit does not freeze the baseline for a later computation on a miss', async () => {
  const root = await project();
  const source = join(root, 'source');
  await writeFile(source, 'before');
  const entry = new CacheEntry({ root, version: 'recompute@1', dependencies: { source: { path: 'source' } } });
  await entry.load();
  await entry.save(new Uint8Array([1]));
  expect(await entry.load()).toEqual(Buffer.from([1]));
  await writeFile(source, 'after');
  expect(await entry.load()).toBeUndefined();
  await entry.save(new Uint8Array([2]));
  expect(await entry.load()).toEqual(Buffer.from([2]));
});

test('persists binary values and metadata and appends one ignore entry', async () => {
  const root = await project();
  await writeFile(join(root, '.gitignore'), 'node_modules');
  const entry = new CacheEntry({ root, version: 'persist@1', dependencies: { model: { value: '模型' } } });
  expect(await entry.has()).toBe(false);
  const bytes = new Uint8Array([0, 255, 128]);
  const saving = entry.save(bytes);
  bytes.fill(42);
  await saving;
  expect(await new CacheEntry({ root, version: 'persist@1', dependencies: { model: { value: '模型' } } }).load()).toEqual(Buffer.from([0, 255, 128]));
  await entry.save(new Uint8Array());
  expect(await entry.has()).toBe(true);
  expect(await entry.load()).toEqual(Buffer.from([]));
  expect(await readdir(join(root, 'public/_vitecache'))).toHaveLength(2);
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules\npublic/_vitecache/*\n');
});

test.each([
  { name: 'Uint8Array view', bytes: new Uint8Array([42, 0, 255, 128, 42]).subarray(1, 4) },
  { name: 'Buffer view', bytes: Buffer.from([42, 0, 255, 128, 42]).subarray(1, 4) },
  { name: 'empty payload', bytes: new Uint8Array() },
])('storage reads and writes compatible metadata for $name', async ({ bytes }) => {
  const root = await project();
  const source = new TextEncoder().encode('模型');
  await writeFile(join(root, 'source'), source);
  await installedPackage(root, 'layout', '1.2.3');
  const dependencies = { source: { path: 'source' }, engine: { package: 'layout' } };
  const options = { root, version: 'compatible@1', dependencies };
  const cacheKey = key(options.version, dependencies);
  const directory = join(root, 'public/_vitecache');
  const record = {
    contentHash: digest(bytes),
    dependencies: { source: digest(source), engine: digest(new TextEncoder().encode('1.2.3')) },
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${cacheKey}.bin`), bytes);
  const metadata = join(directory, `${cacheKey}.json`);
  await writeFile(metadata, JSON.stringify(record));
  expect(await new CacheEntry(options).load()).toEqual(Buffer.from(bytes));

  await createStorage({ root }).save(cacheKey, bytes, dependencies, record.dependencies, {});
  expect(JSON.parse(await readFile(metadata, 'utf8'))).toEqual(record);
  expect(await new CacheEntry(options).load()).toEqual(Buffer.from(bytes));
});

test('validates named dependencies by content and rejects changes during computation', async () => {
  const root = await project();
  const source = join(root, 'model.bin');
  await writeFile(source, 'first');
  const timestamp = new Date('2024-01-01T00:00:00Z');
  await utimes(source, timestamp, timestamp);
  const options = { root, version: 'transform@1', dependencies: { model: { path: 'model.bin' } } };
  const entry = new CacheEntry(options);
  await expect(entry.save(new Uint8Array([1]))).rejects.toThrow();
  expect(await entry.load()).toBeUndefined();
  await entry.save(new Uint8Array([1]));
  expect(await new CacheEntry(options).load()).toEqual(Buffer.from([1]));
  await writeFile(source, 'other');
  await utimes(source, timestamp, timestamp);
  expect(await entry.has()).toBe(false);
  await writeFile(source, 'third');
  await expect(entry.save(new Uint8Array([2]))).rejects.toThrow(/changed/);
  expect(await entry.load()).toBeUndefined();
  await entry.save(new Uint8Array([3]));
  expect(await new CacheEntry(options).has()).toBe(true);
  await unlink(source);
  expect(await entry.load()).toBeUndefined();
  await expect(entry.save(new Uint8Array([4]))).rejects.toThrow();
});

test('torn writes miss while malformed metadata and filesystem failures remain visible', async () => {
  const root = await project();
  const entry = new CacheEntry({ root, version: 'custom@1', basePath: 'generated/cache' });
  await entry.save(new Uint8Array([9]));
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('generated/cache/*\n');
  const files = await readdir(join(root, 'generated/cache'));
  const name = files.find((file) => file.endsWith('.bin'));
  if (!name) throw new Error('Expected cached bytes.');
  const binary = join(root, 'generated/cache', name);
  const metadata = binary.replace(/\.bin$/, '.json');
  await writeFile(binary, new Uint8Array([8]));
  expect(await entry.load()).toBeUndefined();
  await writeFile(metadata, '{}');
  await expect(entry.load()).rejects.toThrow(`Invalid vitecache metadata: ${metadata}`);
  // A malformed saved dependency is the cache file's fault, not a caller's TypeError.
  await writeFile(metadata, JSON.stringify({ contentHash: digest(new Uint8Array([8])), dependencies: {}, saved: { setting: { dependency: { value: 1 }, hash: digest(new Uint8Array()) } } }));
  await expect(entry.load()).rejects.toThrow(expect.objectContaining({ name: 'Error', message: `Invalid vitecache metadata: ${metadata}` }));
  await unlink(metadata);
  expect(await entry.load()).toBeUndefined();
  await writeFile(join(root, 'blocked'), 'a file');
  const blocked = new CacheEntry({ root, version: 'blocked@1', basePath: 'blocked/cache' });
  await expect(blocked.save(new Uint8Array([9]))).rejects.toThrow();
  await expect(blocked.load()).rejects.toThrow();
});

test('concurrent saves append the ignore entry only once', async () => {
  const root = await project();
  await Promise.all(Array.from({ length: 8 }, (_, index) => new CacheEntry({ root, version: `result@${index}` }).save(new Uint8Array([index]))));
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('public/_vitecache/*\n');
});


test('local file URLs resolve to the same dependency as project-relative paths', async () => {
  const root = await project();
  const source = join(root, 'source');
  await writeFile(source, 'source bytes');
  const entry = new CacheEntry({ root, version: 'url@1', dependencies: { source: { url: pathToFileURL(source).href } } });
  await entry.load();
  await entry.save(new Uint8Array([1]));
  const fromPath = new CacheEntry({ root, version: 'url@1', dependencies: { source: { path: 'source' } } });
  expect(await fromPath.load()).toEqual(Buffer.from([1]));
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
  const entry = new CacheEntry({ ...options, dependencies: { source: { url: pathToFileURL(await realpath(source)).href } } });
  await entry.load();
  await entry.save(new Uint8Array([1]));
  expect(await new CacheEntry({ ...options, dependencies: { source: { path: 'source' } } }).load()).toEqual(Buffer.from([1]));
  const link = new CacheEntry({ ...options, dependencies: { source: { url: pathToFileURL(join(linkedRoot, 'source-link')).href } } });
  await link.load();
  await link.save(new Uint8Array([2]));
  expect(await new CacheEntry({ ...options, dependencies: { source: { path: 'source-link' } } }).load()).toEqual(Buffer.from([2]));
});

async function installedPackage(root: string, name: string, version: string): Promise<string> {
  const directory = join(root, 'node_modules', name);
  await mkdir(directory, { recursive: true });
  const manifest = join(directory, 'package.json');
  await writeFile(manifest, JSON.stringify({ name, version, type: 'module', exports: { import: './index.js' } }));
  await writeFile(join(directory, 'index.js'), 'throw new Error("Must not execute the dependency");');
  return manifest;
}

test('package versions invalidate results and cannot replace a computation baseline', async () => {
  const root = await project();
  const manifest = await installedPackage(root, '@example/layout', '1.0.0');
  const options = { root, version: 'layout@1', dependencies: { engine: { package: '@example/layout' }, graph: { value: [1, 2] } } };
  const entry = new CacheEntry(options);
  await expect(entry.save(new Uint8Array([1]))).rejects.toThrow();
  expect(await entry.load()).toBeUndefined();
  await entry.save(new Uint8Array([1]));
  expect(await new CacheEntry(options).load()).toEqual(Buffer.from([1]));
  await writeFile(manifest, JSON.stringify({ version: '2.0.0' }));
  expect(await entry.load()).toBeUndefined();
  await writeFile(manifest, JSON.stringify({ version: '3.0.0' }));
  expect(await entry.has()).toBe(false);
  await expect(entry.save(new Uint8Array([2]))).rejects.toThrow(/changed/);
  expect(await entry.load()).toBeUndefined();
  await entry.save(new Uint8Array([3]));
  expect(await new CacheEntry(options).load()).toEqual(Buffer.from([3]));
  expect(await readdir(join(root, 'public/_vitecache'))).toHaveLength(2);
  await unlink(manifest);
  expect(await entry.load()).toBeUndefined();
  await expect(entry.save(new Uint8Array([4]))).rejects.toThrow();
});

test('package location and declaration order do not affect keys, and values need no baseline', async () => {
  const root = await project();
  const packageRoot = await project();
  await installedPackage(packageRoot, 'layout', '1.0.0');
  await mkdir(join(root, 'node_modules'));
  await symlink(join(packageRoot, 'node_modules/layout'), join(root, 'node_modules/layout'), 'dir');
  const first = new CacheEntry({ root, version: 'portable@1', dependencies: { graph: { value: { b: 2, a: 1 } }, engine: { package: 'layout' } } });
  await first.load();
  await first.save(new Uint8Array([1]));
  await unlink(join(root, 'node_modules/layout'));
  await installedPackage(root, 'layout', '1.0.0');
  const second = new CacheEntry({ root, version: 'portable@1', dependencies: { engine: { package: 'layout' }, graph: { value: { a: 1, b: 2 } } } });
  expect(await second.load()).toEqual(Buffer.from([1]));
  const value = new CacheEntry({ root, version: 'value@1', dependencies: { graph: { value: { nodes: [1] } } } });
  await value.save(new Uint8Array([2]));
  expect(await value.load()).toEqual(Buffer.from([2]));
  expect(await new CacheEntry({ root, version: 'value@1', dependencies: { graph: { value: { nodes: [2] } } } }).load()).toBeUndefined();
});

test('malformed package manifests remain visible rather than becoming cache misses', async () => {
  const root = await project();
  const manifest = await installedPackage(root, 'layout', '1.0.0');
  const entry = new CacheEntry({ root, version: 'layout@1', dependencies: { engine: { package: 'layout' } } });
  await writeFile(manifest, '{');
  await expect(entry.load()).rejects.toThrow(SyntaxError);
  await writeFile(manifest, JSON.stringify({ version: 42 }));
  await expect(entry.load()).rejects.toThrow(/version/);
});
