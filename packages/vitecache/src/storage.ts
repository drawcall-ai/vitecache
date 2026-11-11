import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as disk from './disk.js';
import { dependency, isHashable, resolvedDependencies } from './dependencies.js';
import { contentHash, fileHash } from './hash.js';
import { packageVersion } from './packages.js';
import type { CacheEntryOptions, Dependencies, Hashable, Resolved } from './types.js';

/** A file or package a result was built from, with the hash of its state when it was read. */
export interface Input {
  dependency: Hashable;
  hash: string;
}

/** An entry's metadata file: the hash of its bytes and the inputs that must still be current for them to be used. */
interface Metadata {
  contentHash: string;
  inputs: Input[];
}

const sha256 = /^[a-f0-9]{64}$/;

/** A metadata file vitecache wrote; any failure to read it names the file, since no request caused it. */
function metadata(bytes: Uint8Array, file: string): Metadata | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== 'object' || value === null) throw new Error('Expected an object.');
    // Earlier vitecache versions wrote other metadata. Their entries miss until a save replaces them.
    if (!('inputs' in value)) return undefined;
    if (!('contentHash' in value) || typeof value.contentHash !== 'string' || !sha256.test(value.contentHash)) throw new Error('Expected a content hash.');
    if (!Array.isArray(value.inputs)) throw new Error('Expected inputs.');
    const inputs = value.inputs.map((input: unknown): Input => {
      if (typeof input !== 'object' || input === null || !('dependency' in input) || !('hash' in input)) throw new Error('Expected an input.');
      const declared = dependency(input.dependency);
      if (!isHashable(declared) || typeof input.hash !== 'string' || !sha256.test(input.hash)) throw new Error('Expected a file or package input with its hash.');
      return { dependency: declared, hash: input.hash };
    });
    return { contentHash: value.contentHash, inputs };
  } catch (cause) {
    throw new Error(`Invalid vitecache metadata: ${file}`, { cause });
  }
}

export type Storage = ReturnType<typeof createStorage>;

/** The cache directory on disk, which the Node CacheEntry writes and the Vite plugin serves. */
export function createStorage(options: Pick<CacheEntryOptions, 'root' | 'basePath'>) {
  const { root, directory } = disk.location(options);

  /** The hash of a file's contents or of a package's installed version, or undefined when there is none. */
  async function hash(dependency: Hashable): Promise<string | undefined> {
    if (dependency.package === undefined) return fileHash(resolve(root, dependency.path));
    const version = await packageVersion(root, dependency.package);
    return version === undefined ? undefined : contentHash(new TextEncoder().encode(version));
  }

  async function current(inputs: readonly Input[]): Promise<boolean> {
    const hashes = await Promise.all(inputs.map((input) => hash(input.dependency)));
    return hashes.every((value, index) => value === inputs[index]?.hash);
  }

  return {
    hash,

    /** Local file: URLs as project-root-relative paths. */
    async resolve(declared: Dependencies): Promise<Dependencies<Resolved>> {
      return resolvedDependencies(Object.fromEntries(await Promise.all(Object.entries(declared).map(async ([name, item]) => {
        if (item.url === undefined) return [name, item];
        const url = new URL(item.url);
        if (url.protocol !== 'file:') {
          throw new Error('Node file dependency URLs must use file:. Use a project-root-relative path for Vite-served files.');
        }
        return [name, { path: await disk.rootRelative(root, fileURLToPath(url)) }];
      }))));
    },

    /** The entry's bytes while every input is current, recording its use for prune(); otherwise undefined. */
    async load(key: string): Promise<{ bytes: Uint8Array; tag: string } | undefined> {
      const file = join(directory, `${key}.json`);
      const raw = await disk.load(file);
      if (raw === undefined) return undefined;
      const parsed = metadata(raw, file);
      if (!parsed || !await current(parsed.inputs)) return undefined;
      const bytes = await disk.load(join(directory, `${key}.bin`));
      // Bytes from a save that the metadata does not describe yet, or one interrupted between the two writes.
      if (bytes === undefined || contentHash(bytes) !== parsed.contentHash) return undefined;
      // The metadata file's modification time is the entry's last use. The bytes keep theirs, so static hosts keep their
      // validators.
      await disk.touch(file);
      // The entity tag changes whenever the bytes or the inputs do.
      return { bytes, tag: contentHash(raw) };
    },

    async save(key: string, bytes: Uint8Array, inputs: readonly Input[]): Promise<void> {
      await disk.ignore(root, directory);
      await disk.save(join(directory, `${key}.bin`), bytes);
      const record: Metadata = { contentHash: contentHash(bytes), inputs: [...inputs] };
      await disk.save(join(directory, `${key}.json`), new TextEncoder().encode(JSON.stringify(record)));
    },
  };
}
