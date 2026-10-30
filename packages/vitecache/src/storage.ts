import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as disk from './disk.js';
import { equalHashes, hashes, MissingDependencyError, resolvedDependencies, savedDependencies } from './dependencies.js';
import { packageVersion } from './packages.js';
import type { Backend, CacheEntryOptions, Dependencies, Hashes, ResolvedDependencies, ResolvedDependency, Snapshot } from './types.js';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Metadata {
  contentHash: string;
  dependencies: Hashes;
  /** Saved dependencies with their hashes at save time; absent when there were none. */
  saved?: Readonly<Record<string, { dependency: ResolvedDependency; hash: string }>>;
}

export class ChangedDependenciesError extends Error {
  constructor() {
    super('vitecache dependencies changed during computation.');
  }
}

/** A metadata file vitecache wrote; any failure to read it names the file, since no request caused it. */
function metadata(bytes: Uint8Array, file: string): Metadata {
  try {
    return parse(bytes);
  } catch (cause) {
    throw new Error(`Invalid vitecache metadata: ${file}`, { cause });
  }
}

function parse(bytes: Uint8Array): Metadata {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value !== 'object' || value === null || !('contentHash' in value) || !('dependencies' in value)) {
    throw new Error('Expected contentHash and dependencies.');
  }
  const { contentHash, dependencies } = value;
  if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('Expected a content hash.');
  if (!('saved' in value)) return { contentHash, dependencies: hashes(dependencies) };
  if (typeof value.saved !== 'object' || value.saved === null) throw new Error('Expected saved dependencies.');
  const saved = Object.entries(value.saved).map(([name, item]: [string, unknown]) => {
    if (typeof item !== 'object' || item === null || !('dependency' in item) || !('hash' in item)) throw new Error('Expected a saved dependency and its hash.');
    const dependency = resolvedDependencies(savedDependencies({ [name]: item.dependency }))[name];
    const hash = hashes({ [name]: item.hash })[name];
    if (dependency === undefined || hash === undefined) throw new Error('Expected a saved dependency and its hash.');
    return [name, { dependency, hash }] as const;
  });
  return { contentHash, dependencies: hashes(dependencies), saved: Object.fromEntries(saved) };
}

function matches(current: Snapshot, expected: Hashes): boolean {
  return current.status === 'available' && equalHashes(current.hashes, expected);
}

export function createStorage(options: Pick<CacheEntryOptions, 'root' | 'basePath'> & { memoizeHashes?: boolean }): Backend {
  const { root, directory } = disk.location(options);
  const fileHashes = new Map<string, { size: bigint; mtime: bigint; ctime: bigint; hash: Promise<string | undefined> }>();

  async function fileHash(path: string): Promise<string | undefined> {
    if (!options.memoizeHashes) {
      const bytes = await disk.load(path);
      return bytes === undefined ? undefined : digest(bytes);
    }
    try {
      const { size, mtimeNs: mtime, ctimeNs: ctime } = await stat(path, { bigint: true });
      const cached = fileHashes.get(path);
      if (cached?.size === size && cached.mtime === mtime && cached.ctime === ctime) return await cached.hash;
      const hash = disk.load(path).then((bytes) => bytes === undefined ? undefined : digest(bytes));
      fileHashes.set(path, { size, mtime, ctime, hash });
      const value = await hash;
      if (value === undefined && fileHashes.get(path)?.hash === hash) fileHashes.delete(path);
      return value;
    } catch (error) {
      fileHashes.delete(path);
      throw error;
    }
  }

  async function snapshot(dependencies: ResolvedDependencies): Promise<Snapshot> {
    const entries = await Promise.all(Object.entries(dependencies).filter(([, dependency]) => !('value' in dependency)).map(async ([name, dependency]) => {
      try {
        if (dependency.package !== undefined) {
          const version = await packageVersion(root, dependency.package);
          return version === undefined ? null : [name, digest(new TextEncoder().encode(version))] satisfies [string, string];
        }
        if (dependency.path === undefined) throw new TypeError('Expected a resolved dependency.');
        const hash = await fileHash(resolve(root, dependency.path));
        return hash === undefined ? null : [name, hash] satisfies [string, string];
      } catch (error) {
        if (!disk.missingDependency(error)) throw error;
        return null;
      }
    }));
    const present: [string, string][] = [];
    for (const entry of entries) {
      if (entry === null) return { status: 'missing' };
      present.push(entry);
    }
    return { status: 'available', hashes: Object.fromEntries(present) };
  }

  return {
    async canSave() { return true; },
    async resolve(dependencies: Dependencies) {
      return resolvedDependencies(Object.fromEntries(await Promise.all(Object.entries(dependencies).map(async ([name, dependency]) => {
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
      const file = join(directory, `${key}.json`);
      const record = await disk.load(file);
      if (record === undefined) return undefined;
      const { contentHash, dependencies, saved } = metadata(record, file);
      if (saved) {
        const entries = Object.entries(saved);
        const current = await snapshot(Object.fromEntries(entries.map(([name, { dependency }]) => [name, dependency])));
        if (!matches(current, Object.fromEntries(entries.map(([name, { hash }]) => [name, hash])))) return undefined;
      }
      const bytes = await disk.load(join(directory, `${key}.bin`));
      if (bytes === undefined || digest(bytes) !== contentHash) return undefined;
      return { bytes, hashes: dependencies };
    },
    async save(key, value, validation, expected, saved) {
      if (!matches(await snapshot(validation), expected)) throw new ChangedDependenciesError();
      const current = await snapshot(saved);
      if (current.status !== 'available') throw new MissingDependencyError('Cannot save a cache entry with missing saved dependencies.');
      await disk.ignore(root, directory);
      await disk.save(join(directory, `${key}.bin`), value, async () => {
        if (!matches(await snapshot(validation), expected)) throw new ChangedDependenciesError();
      });
      const record: Metadata = { contentHash: digest(value), dependencies: expected };
      const entries = Object.entries(saved).map(([name, dependency]) => {
        const hash = current.hashes[name];
        if (hash === undefined) throw new Error(`vitecache did not hash saved dependency ${name}.`);
        return [name, { dependency, hash }] as const;
      });
      if (entries.length) record.saved = Object.fromEntries(entries);
      await disk.save(join(directory, `${key}.json`), new TextEncoder().encode(JSON.stringify(record)));
    },
  };
}
