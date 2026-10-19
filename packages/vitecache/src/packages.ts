import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { missingDependency } from './disk.js';

export async function packageVersion(root: string, name: string): Promise<string | undefined> {
  const directories = createRequire(join(root, 'package.json')).resolve.paths(name);
  if (directories === null) throw new TypeError(`Expected an installed package: ${name}`);
  for (const directory of directories) {
    let contents: string;
    try {
      contents = await readFile(join(directory, name, 'package.json'), 'utf8');
    } catch (error) {
      if (!missingDependency(error)) throw error;
      continue;
    }
    const manifest: unknown = JSON.parse(contents);
    if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || typeof manifest.version !== 'string' || !manifest.version.trim()) {
      throw new TypeError(`Package ${name} must declare a nonempty version in package.json.`);
    }
    return manifest.version;
  }
  return undefined;
}
