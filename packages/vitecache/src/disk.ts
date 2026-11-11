import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, rename, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CacheEntryOptions } from './types.js';

function code(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

export function missing(error: unknown): boolean {
  return code(error) === 'ENOENT';
}

/** A filesystem error for a path that does not exist, also below a path component that is a file. */
export function notFound(error: unknown): boolean {
  return missing(error) || code(error) === 'ENOTDIR';
}

/** Whether `path` is `root` or below it, compared lexically. */
export function inside(root: string, path: string): boolean {
  const name = relative(root, path);
  return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

/**
 * `file` relative to `root`, with `/` separators. A file that lies outside `root` only lexically, as through a symlinked
 * root, is related by real paths instead.
 */
export async function rootRelative(root: string, file: string): Promise<string> {
  const path = inside(root, file) ? relative(root, file) : relative(await realpath(root), await realpath(file));
  return path.split(sep).join('/');
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
  if (!path || !inside(root, directory)) return;
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

/**
 * A file's bytes as a plain Uint8Array that owns its whole ArrayBuffer, as a browser's response gives them. A Buffer's
 * slice() shares its memory, so a slice whose buffer is transferred to a worker would detach the bytes it came from.
 */
export async function load(path: string): Promise<Uint8Array | undefined> {
  try {
    const bytes = await readFile(path);
    const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    return owned ? new Uint8Array(bytes.buffer) : new Uint8Array(bytes);
  } catch (error) {
    if (!missing(error)) throw error;
    return undefined;
  }
}

/** Writes `value` to `path` atomically: a reader sees the old file or the new one, never part of it. */
export async function save(path: string, value: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}

const unrecorded = new Set<string>();

/**
 * Sets a file's modification time to now; a file that no longer exists is left alone. Where this process may not change
 * it, as on a read-only deployment, it warns once per directory instead of failing the read that called it.
 */
export async function touch(path: string): Promise<void> {
  try {
    const now = new Date();
    await utimes(path, now, now);
  } catch (error) {
    if (missing(error)) return;
    const reason = code(error);
    if (reason !== 'EROFS' && reason !== 'EACCES' && reason !== 'EPERM') throw error;
    const directory = dirname(path);
    if (!unrecorded.has(directory)) console.warn(`vitecache: cannot record use of entries in ${directory} (${reason}), so prune() treats them as unused.`);
    unrecorded.add(directory);
  }
}
