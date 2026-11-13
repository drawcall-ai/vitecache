import { mkdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import writeFileAtomic from 'write-file-atomic';
import { cacheName, read } from './disk.js';
import { current, record, type Recorded } from './inputs.js';
import { key, tags, type CacheEntryOptions, type Input, type SaveOptions } from './entry.js';
export type { CacheEntryOptions, Dependency, Input, LoadFunction, SaveOptions, Value } from './entry.js';

/**
 * The root and publicDir at `root`; without one, the plugin's once it has run in this process, else the working
 * directory's.
 */
function project(root?: string): { root: string; publicDir: string } {
  if (root === undefined && globalThis.vitecache) return globalThis.vitecache;
  root ??= process.cwd();
  return { root, publicDir: `${root}/public` };
}

/**
 * The URL to read a public file at: for a root-absolute path such as `/tree/model.glts`, the `file:` URL of that file
 * below publicDir, without the path's query and hash. Any other URL is returned unchanged. The publicDir is the
 * plugin's once it has run in this process, else `public` below the working directory.
 */
export function publicURL(url: string): string {
  if (!url.startsWith('/') || url.startsWith('//')) return url;
  const base = pathToFileURL(`${project().publicDir}/`);
  const file = new URL(`.${url.replace(/[?#].*/s, '')}`, base);
  if (!file.href.startsWith(base.href)) throw new Error(`vitecache publicURL: ${url} lies outside publicDir`);
  return file.href;
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
    this.#inputs = Object.values(options.dependencies ?? {}).flatMap((dependency) =>
      'value' in dependency ? tags(dependency.value).flatMap((tag) => tag.inputs) : [dependency],
    );
    const { root, publicDir } = project(options.root);
    this.#root = resolve(root);
    this.#directory = resolve(publicDir, cacheName);
  }

  /** An input as recorded: a `file:` URL becomes a root-relative path, so that metadata holds no machine's paths. */
  #portable(input: Input): Input {
    if (!('path' in input) || !input.path.startsWith('file:')) return input;
    return { path: relative(this.#root, fileURLToPath(input.path)).split(sep).join('/') };
  }

  /** The saved bytes while every input they were built from is unchanged, otherwise undefined. */
  async load(): Promise<Uint8Array | undefined> {
    globalThis.vitecache?.loaded.add(this.#key);
    this.#loaded = await record(this.#root, this.#inputs);
    if (!(await current(this.#root, this.#directory, this.#key))) return undefined;
    return read(join(this.#directory, `${this.#key}.bin`));
  }

  /** Saves the result computed after load(), built from the inputs as that load() found them, plus `dependencies`. */
  async save(value: Uint8Array, options: SaveOptions = {}): Promise<void> {
    if (!this.#loaded) throw new Error('Call CacheEntry.load() before computing the result to save.');
    const saved = (options.dependencies ?? []).map((input) => this.#portable(input));
    const inputs = [...this.#loaded, ...(await record(this.#root, saved))];
    const missing = inputs.find((input) => input.state === undefined);
    if (missing) throw new Error(`vitecache input has no file or package: ${JSON.stringify(missing.dependency)}`);
    // Atomic writes, so that a reader sees the old file or the new one.
    await mkdir(this.#directory, { recursive: true });
    await writeFileAtomic(
      join(this.#directory, `${this.#key}.bin`),
      Buffer.from(value.buffer, value.byteOffset, value.byteLength),
    );
    await writeFileAtomic(join(this.#directory, `${this.#key}.json`), JSON.stringify({ inputs }));
  }
}
