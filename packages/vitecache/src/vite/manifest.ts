import { readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { ResolvedConfig } from 'vite';
import { inside } from './resolve.js';

export function assetUrl(file: string): string {
  return file.split('/').map(encodeURIComponent).join('/');
}

export async function publicPaths(config: ResolvedConfig, cacheDirectory: string): Promise<Record<string, string>> {
  const paths: [string, string][] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const file = resolve(directory, entry.name);
      if (inside(cacheDirectory, file)) continue;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const publicPath = relative(config.publicDir, file).split(sep).join('/');
        paths.push([assetUrl(publicPath), relative(config.root, file).split(sep).join('/')]);
      }
    }
  }
  await visit(config.publicDir);
  return Object.fromEntries(paths);
}
