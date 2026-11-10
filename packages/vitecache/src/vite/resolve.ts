import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Dependencies, Resolved } from '../types.js';
import * as disk from '../disk.js';
import { MissingDependencyError } from '../dependencies.js';

/** A request the plugin refuses, answered with `status` and the message. */
export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function outsideRoot(): RequestError {
  return new RequestError(403, 'File dependencies must be inside the project root');
}

export async function confine(root: string, dependencies: Dependencies<Resolved>): Promise<void> {
  const canonicalRoot = await realpath(root);
  for (const dependency of Object.values(dependencies)) {
    if (!('path' in dependency)) continue;
    const path = resolve(root, dependency.path);
    if (!disk.inside(root, path)) throw outsideRoot();
    try {
      if (!disk.inside(canonicalRoot, await realpath(path))) throw outsideRoot();
    } catch (error) {
      if (!disk.notFound(error)) throw error;
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (!disk.notFound(error)) throw error;
    return false;
  }
}

function decoded(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new RequestError(400, `Malformed file dependency URL: ${pathname}`);
  }
}

export async function resolveDependencies(server: ViteDevServer, dependencies: Dependencies, origin: string): Promise<Dependencies<Resolved>> {
  const entries: [string, Resolved][] = [];
  const base = new URL(server.config.base, origin).pathname;
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!('url' in dependency)) {
      entries.push([name, dependency]);
      continue;
    }
    const url = new URL(dependency.url, origin);
    if (url.origin !== origin) throw new RequestError(400, 'File dependency URLs must have the Vite server origin');
    if (!url.pathname.startsWith(base)) throw new RequestError(400, 'File dependency URL is outside the Vite base');
    const pathname = decoded(`/${url.pathname.slice(base.length)}`);
    const publicFile = resolve(server.config.publicDir, `.${pathname}`);
    const rootFile = resolve(server.config.root, `.${pathname}`);
    let file: string;
    if (await isFile(publicFile)) file = publicFile;
    else if (pathname.startsWith('/@fs/')) file = pathname.slice('/@fs'.length).replace(/^\/([A-Za-z]:\/)/, '$1');
    else if (await isFile(rootFile)) file = rootFile;
    else {
      const module = await server.pluginContainer.resolveId(pathname);
      // A virtual module is served without a file whose contents could be hashed.
      if (!module || !isAbsolute(module.id)) throw new MissingDependencyError(`File dependency URL has no backing file: ${dependency.url}`);
      file = module.id.split('?')[0] ?? module.id;
    }
    if (!await isFile(file)) throw new MissingDependencyError(`File dependency URL has no backing file: ${dependency.url}`);
    entries.push([name, { path: await disk.rootRelative(server.config.root, file) }]);
  }
  const resolved = Object.fromEntries(entries);
  await confine(server.config.root, resolved);
  return resolved;
}
