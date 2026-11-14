import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import writeFileAtomic from 'write-file-atomic';
import { cacheName, read } from './disk.js';
import { current, hashOf, record, type Recorded } from './inputs.js';
import { key, type CacheEntryOptions, type Input, type SaveOptions } from './entry.js';
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
 * The URL to fetch a public file at: for a root-absolute path such as `/tree/model.glb`, a `data:` URL of that file
 * below publicDir, without the path's query and hash, since Node fetches no `file:` URLs. It holds the whole file, so a
 * file must fit in memory as a string. The file becomes an input of the load the plugin is warming. Any other URL is
 * returned unchanged. The publicDir is the plugin's once it has run in this process, else `public` below the working
 * directory.
 */
export function publicURL(url: string): string {
  if (!url.startsWith('/') || url.startsWith('//')) return url;
  const base = pathToFileURL(`${project().publicDir}/`);
  const file = new URL(`.${url.replace(/[?#].*/s, '')}`, base);
  if (!file.href.startsWith(base.href)) throw new Error(`vitecache publicURL: ${url} lies outside publicDir`);
  const bytes = readFileSync(file);
  globalThis.vitecache?.warming.getStore()?.files.push({ dependency: { path: file.href }, state: hashOf(bytes) });
  return `data:application/octet-stream;base64,${bytes.toString('base64')}`;
}

/** A cached result in the cache directory on disk, which Node computes and saves for every environment. */
export class CacheEntry {
  readonly #key: string;
  readonly #inputs: Input[];
  readonly #root: string;
  readonly #directory: string;
  /** The declared inputs as the last load() found them, before the computation read them. */
  #loaded: Recorded[] | undefined;

  constructor(options: CacheEntryOptions) {
    this.#key = key(options);
    const dependencies = Object.values(options.dependencies ?? {});
    this.#inputs = dependencies.filter((dependency): dependency is Input => !('value' in dependency));
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

  /**
   * Saves the result computed after load(), built from the declared inputs as that load() found them, `dependencies`
   * as they are now and, while the plugin warms the load, what it used as it was when the load got it. Throws, and
   * deletes the entry, when an input changed since then, since the result may have been computed from the old content.
   */
  async save(value: Uint8Array, options: SaveOptions = {}): Promise<void> {
    if (!this.#loaded) throw new Error('Call CacheEntry.load() before computing the result to save.');
    const warming = globalThis.vitecache?.warming.getStore();
    const earlier = [...this.#loaded, ...(warming ? [...warming.files, ...warming.modules()] : [])].map(
      ({ dependency, state }) => ({ dependency: this.#portable(dependency), state }),
    );
    const later = (options.dependencies ?? []).map((input) => this.#portable(input));
    const id = (input: Input) => JSON.stringify(input);
    const dependencies = [...earlier.map((input) => input.dependency), ...later];
    const inputs = await record(this.#root, [...new Map(dependencies.map((input) => [id(input), input])).values()]);
    const missing = inputs.find((input) => input.state === undefined);
    if (missing) throw new Error(`vitecache input has no file or package: ${id(missing.dependency)}`);
    const states = new Map(inputs.map((input) => [id(input.dependency), input.state]));
    const changed = earlier.find((input) => states.get(id(input.dependency)) !== input.state);
    if (changed) {
      await Promise.all(
        ['bin', 'json'].map((extension) => rm(join(this.#directory, `${this.#key}.${extension}`), { force: true })),
      );
      throw new Error(`vitecache input changed while the result was computed: ${id(changed.dependency)}`);
    }
    // Atomic writes, so that a reader sees the old file or the new one.
    await mkdir(this.#directory, { recursive: true });
    await writeFileAtomic(
      join(this.#directory, `${this.#key}.bin`),
      Buffer.from(value.buffer, value.byteOffset, value.byteLength),
    );
    await writeFileAtomic(join(this.#directory, `${this.#key}.json`), JSON.stringify({ inputs }));
  }
}
