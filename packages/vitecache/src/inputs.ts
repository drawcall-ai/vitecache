import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missing, read } from './disk.js';
import type { Input } from './entry.js';

/** An input and its state when it was read: a file's hash or a package's version, undefined when it has neither. */
export interface Recorded {
  dependency: Input;
  state: string | undefined;
}

/** The state of a file with these bytes. */
export function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
  const hash = read(path).then((bytes) => bytes && hashOf(bytes));
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

/** The current state of each input, a path read below `root`. */
export function record(root: string, inputs: readonly Input[]): Promise<Recorded[]> {
  return Promise.all(
    inputs.map(async (dependency) => ({
      dependency,
      state:
        'path' in dependency
          ? await fileHash(
              dependency.path.startsWith('file:') ? fileURLToPath(dependency.path) : resolve(root, dependency.path),
            )
          : await packageVersion(root, dependency.package),
    })),
  );
}

/** Whether the entry `key` in `directory` was saved from inputs that are all unchanged below `root`. */
export async function current(root: string, directory: string, key: string): Promise<boolean> {
  const metadata = await read(join(directory, `${key}.json`));
  if (!metadata) return false;
  // Written by save() below; any other shape compares unequal. Metadata from before 0.4 has no inputs, and misses.
  const { inputs }: { inputs?: Recorded[] } = JSON.parse(new TextDecoder().decode(metadata));
  if (!inputs) return false;
  const now = await record(
    root,
    inputs.map((input) => input.dependency),
  );
  return JSON.stringify(now) === JSON.stringify(inputs);
}
