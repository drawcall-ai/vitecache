import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as disk from './disk.js';
import { equalHashes, hashes, paths } from './dependencies.js';
import { digest } from './key.js';
import type { Backend, CacheEntryOptions, FileDependencies, Hashes, Paths } from './types.js';

interface Metadata {
  contentHash: string;
  fileDependencies: Hashes;
}

export class ChangedDependenciesError extends Error {
  constructor() {
    super('vitecache file dependencies changed during computation.');
  }
}

function metadata(bytes: Uint8Array): Metadata {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value !== 'object' || value === null || !('contentHash' in value) || !('fileDependencies' in value)) {
    throw new Error('Invalid vitecache metadata.');
  }
  const { contentHash, fileDependencies } = value;
  if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error('Invalid vitecache metadata.');
  }
  return { contentHash, fileDependencies: hashes(fileDependencies) };
}

function matches(current: Hashes | null, expected: Hashes): boolean {
  return current !== null && equalHashes(current, expected);
}

export function createStorage(options: Pick<CacheEntryOptions, 'root' | 'basePath'>): Backend {
  const { root, directory } = disk.location(options);

  async function snapshot(files: Paths): Promise<Hashes | null> {
    const entries = await Promise.all(Object.entries(files).map(async ([name, path]) => {
      try {
        const bytes = await disk.load(resolve(root, path));
        return bytes === undefined ? null : [name, digest(bytes)] satisfies [string, string];
      } catch (error) {
        if (!disk.missingDependency(error)) throw error;
        return null;
      }
    }));
    const present: [string, string][] = [];
    for (const entry of entries) {
      if (entry === null) return null;
      present.push(entry);
    }
    return Object.fromEntries(present);
  }

  return {
    async canSave() { return true; },
    async resolve(files: FileDependencies) {
      return paths(Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, dependency]) => {
        if (dependency.path !== undefined) return [name, dependency.path];
        const url = new URL(dependency.url);
        if (url.protocol !== 'file:') {
          throw new Error('Node file dependency URLs must use file:. Use a project-root-relative path for Vite-served files.');
        }
        const file = fileURLToPath(url);
        let path = relative(root, file);
        if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
          path = relative(await realpath(root), await realpath(file));
        }
        return [name, path.split(sep).join('/')];
      }))));
    },
    snapshot,
    async load(key) {
      const record = await disk.load(join(directory, `${key}.json`));
      if (record === undefined) return undefined;
      const { contentHash, fileDependencies } = metadata(record);
      const bytes = await disk.load(join(directory, `${key}.bin`));
      if (bytes === undefined || digest(bytes) !== contentHash) return undefined;
      return { bytes, hashes: fileDependencies };
    },
    async save(key, value, files, expected) {
      if (!matches(await snapshot(files), expected)) throw new ChangedDependenciesError();
      await disk.ignore(root, directory);
      await disk.save(join(directory, `${key}.bin`), value, async () => {
        if (!matches(await snapshot(files), expected)) throw new ChangedDependenciesError();
      });
      const record: Metadata = { contentHash: digest(value), fileDependencies: expected };
      await disk.save(join(directory, `${key}.json`), new TextEncoder().encode(JSON.stringify(record)));
    },
  };
}
