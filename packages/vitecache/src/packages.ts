import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { notFound } from './disk.js';

type Manifest = { name?: unknown; version?: unknown };

async function readManifest(directory: string): Promise<Manifest | undefined> {
  const file = join(directory, 'package.json');
  let contents: string;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if (!notFound(error)) throw error;
    return undefined;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch (cause) {
    throw new Error(`Invalid package manifest: ${file}`, { cause });
  }
  if (typeof manifest !== 'object' || manifest === null) throw new TypeError(`Expected an object in ${file}.`);
  return manifest;
}

function version(name: string, manifest: Manifest): string {
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new TypeError(`Package ${name} must declare a nonempty version in package.json.`);
  }
  return manifest.version;
}

/**
 * The installed version of package `name` as seen from `root`. The project at `root` resolves its own name to itself
 * before node_modules. Node does that only when its package.json declares `exports`; this does without, as a version
 * needs no entry point.
 */
export async function packageVersion(root: string, name: string): Promise<string | undefined> {
  const own = await readManifest(root);
  if (own?.name === name) return version(name, own);
  const directories = createRequire(join(root, 'package.json')).resolve.paths(name);
  if (directories === null) throw new TypeError(`Expected an installed package: ${name}`);
  for (const directory of directories) {
    const manifest = await readManifest(join(directory, name));
    if (manifest !== undefined) return version(name, manifest);
  }
  return undefined;
}
