import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CacheEntryOptions } from './types.js';

export function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function missingDependency(error: unknown): boolean {
  return missing(error) || (error instanceof Error && 'code' in error && error.code === 'ENOTDIR');
}

export function location(options: Pick<CacheEntryOptions, 'root' | 'basePath'>): { root: string; directory: string } {
  const root = resolve(options.root ?? process.cwd());
  return { root, directory: resolve(root, options.basePath ?? 'public/_vitecache') };
}

const pending = new Map<string, Promise<void>>();

export function ignore(root: string, directory: string): Promise<void> {
  const key = `${root}\0${directory}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const result = updateIgnore(root, directory).finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}

async function updateIgnore(root: string, directory: string): Promise<void> {
  const path = relative(root, directory);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return;
  const entry = `${path.split(sep).join('/').replace(/[!*?[\]# ]/g, '\\$&')}/*`;
  const file = join(root, '.gitignore');
  await mkdir(root, { recursive: true });
  let contents = '';
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (contents.split(/\r?\n/).includes(entry)) return;
  await appendFile(file, `${contents && !contents.endsWith('\n') ? '\n' : ''}${entry}\n`);
}

export async function load(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (!missing(error)) throw error;
    return undefined;
  }
}

export async function save(path: string, value: Uint8Array, beforeCommit?: () => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { flag: 'wx' });
    await beforeCommit?.();
    await rename(temporary, path);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
