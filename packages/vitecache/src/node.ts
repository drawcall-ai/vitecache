import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import writeFileAtomic from 'write-file-atomic';
import { missing, read } from './disk.js';
import { key, type CacheEntryOptions, type Input, type SaveOptions } from './entry.js';
import { project, shared } from './shared.js';
export { publicURL } from './shared.js';
export type { CacheEntryOptions, Dependency, Input, JsonValue, SaveOptions } from './entry.js';

/** An input and its state when it was read: a file's hash or a package's version, undefined when it has neither. */
interface Recorded {
  dependency: Input;
  state: string | undefined;
}

/**
 * File hashes by path, reused while size, mtime and ctime are unchanged. As git does, a hash taken within two seconds
 * of the file's mtime is not kept, since a write in the same timestamp tick could follow it unseen.
 */
const fileHashes = new Map<string, { stats: string; hash: Promise<string | undefined> }>();

async function fileHash(path: string): Promise<string | undefined> {
  const stats = await stat(path, { bigint: true }).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (!stats) return undefined;
  const signature = [stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join();
  const known = fileHashes.get(path);
  if (known?.stats === signature) return known.hash;
  const hash = read(path).then((bytes) => bytes && createHash('sha256').update(bytes).digest('hex'));
  if (BigInt(Date.now()) * 1_000_000n - stats.mtimeNs < 2_000_000_000n) fileHashes.delete(path);
  else fileHashes.set(path, { stats: signature, hash });
  return hash;
}

/** The installed version of a package as `root` resolves it, its own name included. */
async function packageVersion(root: string, name: string): Promise<string | undefined> {
  const own = join(root, 'package.json');
  const directories = createRequire(own).resolve.paths(name) ?? [];
  for (const file of [own, ...directories.map((directory) => join(directory, name, 'package.json'))]) {
    const bytes = await read(file);
    if (!bytes) continue;
    const manifest: { name?: unknown; version?: unknown } = JSON.parse(new TextDecoder().decode(bytes));
    if (file === own && manifest.name !== name) continue;
    if (typeof manifest.version !== 'string') throw new TypeError(`${file} declares no version.`);
    return manifest.version;
  }
  return undefined;
}

/** A cached result in the cache directory on disk, which Node computes and saves for every environment. */
export class CacheEntry {
  readonly #key: string;
  readonly #inputs: Input[];
  readonly #root: string;
  readonly #directory: string;
  /** The declared inputs as the last load() found them, which save() records as what the result was built from. */
  #loaded: Recorded[] | undefined;

  constructor(options: CacheEntryOptions) {
    this.#key = key(options);
    const dependencies = Object.values(options.dependencies ?? {});
    this.#inputs = dependencies.filter((dependency): dependency is Input => !('value' in dependency));
    const { root, publicDir } = project(options.root);
    this.#root = resolve(root);
    this.#directory = resolve(publicDir, '_vitecache');
  }

  /** An input's file, named by a `file:` URL or a path relative to the root. */
  #file(path: string): string {
    return path.startsWith('file:') ? fileURLToPath(path) : resolve(this.#root, path);
  }

  #record(inputs: readonly Input[]): Promise<Recorded[]> {
    return Promise.all(
      inputs.map(async (dependency) => ({
        dependency,
        state:
          'path' in dependency
            ? await fileHash(this.#file(dependency.path))
            : await packageVersion(this.#root, dependency.package),
      })),
    );
  }

  /** The saved bytes while every input they were built from is unchanged, otherwise undefined. */
  async load(): Promise<Uint8Array | undefined> {
    shared.used.set(this.#key, Date.now());
    this.#loaded = await this.#record(this.#inputs);
    const metadata = await read(join(this.#directory, `${this.#key}.json`));
    if (!metadata) return undefined;
    // Written by save() below; any other shape compares unequal. Metadata from before 0.4 has no inputs, and misses.
    const { inputs }: { inputs?: Recorded[] } = JSON.parse(new TextDecoder().decode(metadata));
    if (!inputs) return undefined;
    const current = await this.#record(inputs.map((input) => input.dependency));
    if (JSON.stringify(current) !== JSON.stringify(inputs)) return undefined;
    return read(join(this.#directory, `${this.#key}.bin`));
  }

  /** Saves the result computed after load(), built from the inputs as that load() found them, plus `dependencies`. */
  async save(value: Uint8Array, options: SaveOptions = {}): Promise<void> {
    if (!this.#loaded) throw new Error('Call CacheEntry.load() before computing the result to save.');
    const inputs = [...this.#loaded, ...(await this.#record(options.dependencies ?? []))];
    const missing = inputs.find((input) => input.state === undefined);
    if (missing) throw new Error(`vitecache input has no file or package: ${JSON.stringify(missing.dependency)}`);
    shared.saves++;
    // Atomic writes, so that a reader sees the old file or the new one.
    await mkdir(this.#directory, { recursive: true });
    await writeFileAtomic(
      join(this.#directory, `${this.#key}.bin`),
      Buffer.from(value.buffer, value.byteOffset, value.byteLength),
    );
    await writeFileAtomic(join(this.#directory, `${this.#key}.json`), JSON.stringify({ inputs }));
  }
}
