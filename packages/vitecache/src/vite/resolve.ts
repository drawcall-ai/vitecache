import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Dependencies, ResolvedDependencies, ResolvedDependency } from '../types.js';
import * as disk from '../disk.js';

export class OutsideRootError extends Error {
  constructor() {
    super('File dependencies must be inside the project root');
  }
}

export function inside(root: string, path: string): boolean {
  const name = relative(root, path);
  return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

export async function confine(root: string, dependencies: ResolvedDependencies): Promise<void> {
  const canonicalRoot = await realpath(root);
  for (const dependency of Object.values(dependencies)) {
    if (!('path' in dependency)) continue;
    const path = resolve(root, dependency.path);
    if (!inside(root, path)) throw new OutsideRootError();
    try {
      if (!inside(canonicalRoot, await realpath(path))) throw new OutsideRootError();
    } catch (error) {
      if (!disk.missingDependency(error)) throw error;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (!disk.missingDependency(error)) throw error;
    return false;
  }
}

export async function resolveDependencies(server: ViteDevServer, dependencies: Dependencies, origin: string): Promise<ResolvedDependencies> {
  const entries: [string, ResolvedDependency][] = [];
  const base = new URL(server.config.base, origin).pathname;
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!('url' in dependency)) {
      entries.push([name, dependency]);
      continue;
    }
    const url = new URL(dependency.url, origin);
    if (url.origin !== origin) throw new TypeError('File dependency URLs must have the Vite server origin');
    if (!url.pathname.startsWith(base)) throw new TypeError('File dependency URL is outside the Vite base');
    const pathname = decodeURIComponent(`/${url.pathname.slice(base.length)}`);
    const publicFile = resolve(server.config.publicDir, `.${pathname}`);
    const rootFile = resolve(server.config.root, `.${pathname}`);
    let file: string;
    if (server.config.publicDir && await exists(publicFile)) file = publicFile;
    else if (pathname.startsWith('/@fs/')) file = pathname.slice('/@fs'.length).replace(/^\/([A-Za-z]:\/)/, '$1');
    else if (await exists(rootFile)) file = rootFile;
    else {
      const module = await server.pluginContainer.resolveId(pathname);
      if (!module || !isAbsolute(module.id)) throw new TypeError(`Cannot resolve file dependency URL: ${dependency.url}`);
      file = module.id.split('?')[0] ?? module.id;
    }
    if (!await exists(file)) throw new TypeError(`File dependency URL has no backing file: ${dependency.url}`);
    const path = inside(server.config.root, file)
      ? relative(server.config.root, file)
      : relative(await realpath(server.config.root), await realpath(file));
    entries.push([name, { path: path.split(sep).join('/') }]);
  }
  const resolved = Object.fromEntries(entries);
  await confine(server.config.root, resolved);
  return resolved;
}
