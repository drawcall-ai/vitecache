import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as disk from './disk.js';
import { equalHashes, hashes, resolvedDependencies } from './dependencies.js';
import { packageVersion } from './packages.js';
import { digest } from './key.js';
import type { Backend, CacheEntryOptions, Dependencies, Hashes, ResolvedDependencies } from './types.js';

interface Metadata {
  contentHash: string;
  dependencies: Hashes;
}

export class ChangedDependenciesError extends Error {
  constructor() {
    super('vitecache dependencies changed during computation.');
  }
}

function metadata(bytes: Uint8Array): Metadata {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value !== 'object' || value === null || !('contentHash' in value) || !('dependencies' in value)) {
    throw new Error('Invalid vitecache metadata.');
  }
  const { contentHash, dependencies } = value;
  if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error('Invalid vitecache metadata.');
  }
  return { contentHash, dependencies: hashes(dependencies) };
}

function matches(current: Hashes | null, expected: Hashes): boolean {
  return current !== null && equalHashes(current, expected);
}

export function createStorage(options: Pick<CacheEntryOptions, 'root' | 'basePath'>): Backend {
  const { root, directory } = disk.location(options);

  async function snapshot(dependencies: ResolvedDependencies): Promise<Hashes | null> {
    const entries = await Promise.all(Object.entries(dependencies).filter(([, dependency]) => !('value' in dependency)).map(async ([name, dependency]) => {
      try {
        if (dependency.package !== undefined) {
          const version = await packageVersion(root, dependency.package);
          return version === undefined ? null : [name, digest(new TextEncoder().encode(version))] satisfies [string, string];
        }
        if (dependency.path === undefined) throw new TypeError('Expected a resolved dependency.');
        const bytes = await disk.load(resolve(root, dependency.path));
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
    async resolve(files: Dependencies) {
      return resolvedDependencies(Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, dependency]) => {
        if (dependency.url === undefined) return [name, dependency];
        const url = new URL(dependency.url);
        if (url.protocol !== 'file:') {
          throw new Error('Node file dependency URLs must use file:. Use a project-root-relative path for Vite-served files.');
        }
        const file = fileURLToPath(url);
        let path = relative(root, file);
        if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
          path = relative(await realpath(root), await realpath(file));
        }
        return [name, { path: path.split(sep).join('/') }];
      }))));
    },
    snapshot,
    async load(key) {
      const record = await disk.load(join(directory, `${key}.json`));
      if (record === undefined) return undefined;
      const { contentHash, dependencies } = metadata(record);
      const bytes = await disk.load(join(directory, `${key}.bin`));
      if (bytes === undefined || digest(bytes) !== contentHash) return undefined;
      return { bytes, hashes: dependencies };
    },
    async save(key, value, files, expected) {
      if (!matches(await snapshot(files), expected)) throw new ChangedDependenciesError();
      await disk.ignore(root, directory);
      await disk.save(join(directory, `${key}.bin`), value, async () => {
        if (!matches(await snapshot(files), expected)) throw new ChangedDependenciesError();
      });
      const record: Metadata = { contentHash: digest(value), dependencies: expected };
      await disk.save(join(directory, `${key}.json`), new TextEncoder().encode(JSON.stringify(record)));
    },
  };
}
