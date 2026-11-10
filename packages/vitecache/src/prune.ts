import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as disk from './disk.js';
import type { CacheEntryOptions } from './types.js';

export interface PruneOptions extends Pick<CacheEntryOptions, 'root' | 'basePath'> {
  /** Entries not loaded or saved since this time are deleted. */
  before: Date;
}

/** An entry's bytes or metadata. */
const entryFile = /^([a-f0-9]{64})\.(?:bin|json)$/;
/** Either one staged by a save, unfinished while recent and abandoned once old. */
const stagedFile = /^[a-f0-9]{64}\.(?:bin|json)\.[^.]+\.tmp$/;

/**
 * Deletes cache entries that no load or save used since `before` and returns their keys. Also deletes files that saves
 * staged before it, which no save will finish. Loads in Node and through the Vite development server count as use;
 * deployed browsers do not. Other files in the cache directory are kept.
 */
export async function prune(options: PruneOptions): Promise<string[]> {
  const time = options.before.getTime();
  if (Number.isNaN(time)) throw new TypeError('prune requires a valid before date.');
  // Some filesystems store whole seconds, so a use just after `before` can be recorded just before it.
  const cutoff = Math.floor(time / 1000) * 1000;
  const { directory } = disk.location(options);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (!disk.missing(error)) throw error;
    return [];
  }
  const files = await Promise.all(names.filter((name) => entryFile.test(name) || stagedFile.test(name)).map(async (name) => ({
    name,
    modified: await modified(join(directory, name)),
  })));
  const abandoned: string[] = [];
  const entries = new Map<string, { files: string[]; used: number }>();
  for (const { name, modified } of files) {
    const key = entryFile.exec(name)?.[1];
    if (key === undefined) {
      if (modified < cutoff) abandoned.push(name);
      continue;
    }
    const entry = entries.get(key) ?? { files: [], used: -Infinity };
    entries.set(key, entry);
    entry.files.push(name);
    entry.used = Math.max(entry.used, modified);
  }
  const unused = [...entries].filter(([, { used }]) => used < cutoff);
  await Promise.all([...abandoned, ...unused.flatMap(([, entry]) => entry.files)].map((name) => remove(join(directory, name))));
  return unused.map(([key]) => key);
}

async function modified(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (!disk.missing(error)) throw error;
    // A save renamed or removed it since the listing, so it is in use.
    return Infinity;
  }
}

async function remove(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!disk.missing(error)) throw error;
  }
}
