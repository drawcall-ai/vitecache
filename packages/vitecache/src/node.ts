import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import writeFileAtomic from 'write-file-atomic';
import { cacheName, read } from './disk.js';
import { current, record, type Recorded } from './inputs.js';
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
  const path = fileURLToPath(file);
  globalThis.vitecache?.warming.getStore()?.files.add(path);
  return `data:application/octet-stream;base64,${readFileSync(path).toString('base64')}`;
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
    this.#directory = resolve(publicDir, cacheName);
  }

  /** A file as recorded: root-relative, so that metadata holds no machine's paths. */
  #relative(file: string): Input {
    return { path: relative(this.#root, file).split(sep).join('/') };
  }

  /** An input as recorded: a `file:` URL becomes a root-relative path. */
  #portable(input: Input): Input {
    return 'path' in input && input.path.startsWith('file:') ? this.#relative(fileURLToPath(input.path)) : input;
  }

  /** The saved bytes while every input they were built from is unchanged, otherwise undefined. */
  async load(): Promise<Uint8Array | undefined> {
    globalThis.vitecache?.loaded.add(this.#key);
    this.#loaded = await record(this.#root, this.#inputs);
    if (!(await current(this.#root, this.#directory, this.#key))) return undefined;
    return read(join(this.#directory, `${this.#key}.bin`));
  }

  /**
   * Saves the result computed after load(), built from the inputs as that load() found them, plus `dependencies` and,
   * while the plugin warms the load, the modules it ran, as their package's package.json for an installed one, and the
   * public files publicURL gave it.
   */
  async save(value: Uint8Array, options: SaveOptions = {}): Promise<void> {
    if (!this.#loaded) throw new Error('Call CacheEntry.load() before computing the result to save.');
    const warming = globalThis.vitecache?.warming.getStore();
    const used = new Set(warming ? [...warming.modules(), ...warming.files] : []);
    const saved = [
      ...(options.dependencies ?? []).map((input) => this.#portable(input)),
      ...[...used].map((file) => this.#relative(file)),
    ];
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
