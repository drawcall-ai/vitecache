import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as disk from './disk.js';
import { ChangedDependenciesError, equalHashes, hashableDependencies, hashes, MissingDependencyError, resolvedDependencies } from './dependencies.js';
import { contentHash, fileHash } from './hash.js';
import { packageVersion } from './packages.js';
import type { Backend, CacheEntryOptions, Dependencies, Hashable, Hashes, Snapshot, Stored } from './types.js';

interface Metadata {
  contentHash: string;
  dependencies: Hashes;
  saved: Dependencies<Hashable>;
  /** The saved dependencies' hashes when the entry was saved. */
  savedHashes: Hashes;
}

/** A metadata file vitecache wrote; any failure to read it names the file, since no request caused it. */
function metadata(bytes: Uint8Array, file: string): Metadata | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== 'object' || value === null || !('contentHash' in value) || !('dependencies' in value)) {
      throw new Error('Expected contentHash and dependencies.');
    }
    const hash = value.contentHash;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Expected a content hash.');
    const validated = hashes(value.dependencies);
    // Metadata without saved dependencies: all that vitecache 0.1 wrote, and what 0.2 wrote for entries that had none.
    if (!('saved' in value)) return { contentHash: hash, dependencies: validated, saved: {}, savedHashes: {} };
    // vitecache 0.2 kept each saved dependency with its hash in one record. Its entry misses until a save replaces it.
    if (!('savedHashes' in value)) return undefined;
    return { contentHash: hash, dependencies: validated, saved: hashableDependencies(value.saved), savedHashes: hashes(value.savedHashes) };
  } catch (cause) {
    throw new Error(`Invalid vitecache metadata: ${file}`, { cause });
  }
}

/** A stored entry as storage reads it, its hashes always known. */
export interface Found extends Stored {
  /** The entity tag's opaque value: it changes whenever the entry's bytes or dependency hashes do. */
  tag: string;
  hashes: Hashes;
}

export interface Storage extends Backend {
  /** Reads a valid entry and records its use for prune(). */
  load(key: string): Promise<Found | undefined>;
}

function matches(current: Snapshot, expected: Hashes): boolean {
  return current.status === 'current' && equalHashes(current.hashes, expected);
}

export function createStorage(options: Pick<CacheEntryOptions, 'root' | 'basePath'>): Storage {
  const { root, directory } = disk.location(options);

  async function snapshot(dependencies: Dependencies<Hashable>): Promise<Exclude<Snapshot, { status: 'unchecked' }>> {
    const entries = await Promise.all(Object.entries(dependencies).map(async ([name, dependency]) => {
      if (dependency.package === undefined) return [name, await fileHash(resolve(root, dependency.path))] as const;
      const version = await packageVersion(root, dependency.package);
      return [name, version === undefined ? undefined : contentHash(new TextEncoder().encode(version))] as const;
    }));
    const present: [string, string][] = [];
    for (const [name, hash] of entries) {
      if (hash === undefined) return { status: 'missing', message: `Missing file or package dependency: ${name}` };
      present.push([name, hash]);
    }
    return { status: 'current', hashes: Object.fromEntries(present) };
  }

  async function load(key: string): Promise<Found | undefined> {
    const file = join(directory, `${key}.json`);
    const raw = await disk.load(file);
    if (raw === undefined) return undefined;
    const parsed = metadata(raw, file);
    if (!parsed || !matches(await snapshot(parsed.saved), parsed.savedHashes)) return undefined;
    const bytes = await disk.load(join(directory, `${key}.bin`));
    if (bytes === undefined || contentHash(bytes) !== parsed.contentHash) return undefined;
    // The metadata file's modification time is the entry's last use. The bytes keep theirs, so static hosts keep their
    // validators.
    await disk.touch(file);
    return { tag: contentHash(raw), hashes: parsed.dependencies, bytes };
  }

  return {
    async canSave() { return true; },
    async resolve(declared: Dependencies) {
      return resolvedDependencies(Object.fromEntries(await Promise.all(Object.entries(declared).map(async ([name, dependency]) => {
        if (dependency.url === undefined) return [name, dependency];
        const url = new URL(dependency.url);
        if (url.protocol !== 'file:') {
          throw new Error('Node file dependency URLs must use file:. Use a project-root-relative path for Vite-served files.');
        }
        return [name, { path: await disk.rootRelative(root, fileURLToPath(url)) }];
      }))));
    },
    snapshot,
    load,
    async save(key, value, { checked, expected, saved }) {
      const current = await snapshot(saved);
      if (current.status !== 'current') throw new MissingDependencyError(`Cannot save a cache entry with a missing saved dependency. ${current.message}`);
      await disk.ignore(root, directory);
      await disk.save(join(directory, `${key}.bin`), value, async () => {
        if (!matches(await snapshot(checked), expected)) throw new ChangedDependenciesError();
      });
      const record: Metadata = { contentHash: contentHash(value), dependencies: expected, saved, savedHashes: current.hashes };
      await disk.save(join(directory, `${key}.json`), new TextEncoder().encode(JSON.stringify(record)));
    },
  };
}
