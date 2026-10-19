import { mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import * as disk from '../src/disk.js';
import { CacheEntry } from '../src/node.js';

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

test('a dependency change while staging bytes does not publish the rejected result', async () => {
  const root = await project();
  const source = join(root, 'source');
  await writeFile(source, 'before');
  const entry = new CacheEntry({ root, version: 'race@1', fileDependencies: { source: { path: 'source' } } });
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
  const entry = new CacheEntry({ root, version: 'baseline@1', fileDependencies: { source: { path: 'source' } } });
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
  const entry = new CacheEntry({ root, version: 'recompute@1', fileDependencies: { source: { path: 'source' } } });
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
  const entry = new CacheEntry({ root, version: 'persist@1', inputs: { model: '模型' } });
  expect(await entry.has()).toBe(false);
  const bytes = new Uint8Array([0, 255, 128]);
  const saving = entry.save(bytes);
  bytes.fill(42);
  await saving;
  expect(await new CacheEntry({ root, version: 'persist@1', inputs: { model: '模型' } }).load()).toEqual(Buffer.from([0, 255, 128]));
  await entry.save(new Uint8Array());
  expect(await entry.has()).toBe(true);
  expect(await entry.load()).toEqual(Buffer.from([]));
  expect(await readdir(join(root, 'public/_vitecache'))).toHaveLength(2);
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules\npublic/_vitecache/*\n');
});

test('validates named dependencies by content and rejects changes during computation', async () => {
  const root = await project();
  const source = join(root, 'model.bin');
  await writeFile(source, 'first');
  const options = { root, version: 'transform@1', fileDependencies: { model: { path: 'model.bin' } } };
  const entry = new CacheEntry(options);
  await expect(entry.save(new Uint8Array([1]))).rejects.toThrow();
  expect(await entry.load()).toBeUndefined();
  await entry.save(new Uint8Array([1]));
  expect(await new CacheEntry(options).load()).toEqual(Buffer.from([1]));
  await writeFile(source, 'second');
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
  await expect(entry.load()).rejects.toThrow(/metadata/);
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
  const entry = new CacheEntry({ root, version: 'url@1', fileDependencies: { source: { url: pathToFileURL(source).href } } });
  await entry.load();
  await entry.save(new Uint8Array([1]));
  const fromPath = new CacheEntry({ root, version: 'url@1', fileDependencies: { source: { path: 'source' } } });
  expect(await fromPath.load()).toEqual(Buffer.from([1]));
  await expect(new CacheEntry({ root, version: 'url@1', fileDependencies: { source: { url: 'https://localhost/source' } } }).load()).rejects.toThrow(/project-root-relative path/);
  const outside = join(await project(), 'source');
  await writeFile(outside, 'outside');
  await expect(new CacheEntry({ root, version: 'url@1', fileDependencies: { source: { url: pathToFileURL(outside).href } } }).load()).rejects.toThrow(/project root/);
});


test('file URLs resolve through a symlinked project root without rewriting declared symlinks', async () => {
  const root = await project();
  const source = join(root, 'source');
  await writeFile(source, 'source');
  await symlink(source, join(root, 'source-link'));
  const linkedRoot = join(await project(), 'project');
  await symlink(root, linkedRoot, 'dir');
  const options = { root: linkedRoot, version: 'symlink@1' };
  const entry = new CacheEntry({ ...options, fileDependencies: { source: { url: pathToFileURL(await realpath(source)).href } } });
  await entry.load();
  await entry.save(new Uint8Array([1]));
  expect(await new CacheEntry({ ...options, fileDependencies: { source: { path: 'source' } } }).load()).toEqual(Buffer.from([1]));
  const link = new CacheEntry({ ...options, fileDependencies: { source: { url: pathToFileURL(join(linkedRoot, 'source-link')).href } } });
  await link.load();
  await link.save(new Uint8Array([2]));
  expect(await new CacheEntry({ ...options, fileDependencies: { source: { path: 'source-link' } } }).load()).toEqual(Buffer.from([2]));
});
