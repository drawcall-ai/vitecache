import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { key } from '../src/key.js';
import { CacheEntry } from '../src/node.js';
import { prune } from '../src/prune.js';

const readOnly = vi.hoisted(() => ({ value: false }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    utimes: vi.fn((...args: Parameters<typeof fs.utimes>) => readOnly.value ? Promise.reject(Object.assign(new Error('read-only'), { code: 'EROFS' })) : fs.utimes(...args)),
  };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vitecache-prune-'));
  roots.push(root);
  return root;
}

test('deletes only entries unused since the cutoff and abandoned staged files', async () => {
  const root = await temporaryRoot();
  const directory = join(root, 'public/_vitecache');
  await new CacheEntry({ root, version: 'used@1' }).save(new Uint8Array([1]));
  await new CacheEntry({ root, version: 'unused@1' }).save(new Uint8Array([2]));
  const unused = key('unused@1', {});
  const used = key('used@1', {});
  await writeFile(join(directory, `${unused}.bin.0b5e-crashed.tmp`), 'partial');
  await writeFile(join(directory, `${used}.json.1c6f-crashed.tmp`), 'partial');
  await writeFile(join(directory, 'notes.txt'), 'not a cache file');
  const old = new Date('2020-01-01');
  for (const name of await readdir(directory)) await utimes(join(directory, name), old, old);
  await writeFile(join(directory, `${unused}.json.2d70-saving.tmp`), 'partial');

  const before = new Date('2021-01-01');
  expect(await new CacheEntry({ root, version: 'used@1' }).load()).toEqual(new Uint8Array([1]));
  expect(await prune({ root, before })).toEqual([unused]);
  expect((await readdir(directory)).sort()).toEqual([`${unused}.json.2d70-saving.tmp`, `${used}.bin`, `${used}.json`, 'notes.txt'].sort());
  expect(await new CacheEntry({ root, version: 'used@1' }).load()).toEqual(new Uint8Array([1]));
});

test('rejects an invalid date, and finds nothing to prune in an absent cache directory', async () => {
  const root = await temporaryRoot();
  await expect(prune({ root, before: new Date('invalid') })).rejects.toThrow(TypeError);
  expect(await prune({ root, basePath: 'absent', before: new Date() })).toEqual([]);
});

test('a filesystem that cannot record use still serves hits and warns once', async () => {
  const root = await temporaryRoot();
  await new CacheEntry({ root, version: 'read-only@1' }).save(new Uint8Array([1]));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  readOnly.value = true;
  try {
    for (let loads = 0; loads < 2; loads++) expect(await new CacheEntry({ root, version: 'read-only@1' }).load()).toEqual(new Uint8Array([1]));
    expect(warn).toHaveBeenCalledOnce();
  } finally {
    readOnly.value = false;
    warn.mockRestore();
  }
});
