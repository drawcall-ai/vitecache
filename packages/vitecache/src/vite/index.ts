import { relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import * as disk from '../disk.js';
import { ChangedDependenciesError, createStorage } from '../storage.js';
import type { Backend } from '../types.js';
import { dependencies, hashes, MissingDependencyError, resolvedDependencies, savedDependencies } from '../dependencies.js';
import { confine, inside, OutsideRootError, resolveDependencies } from './resolve.js';
import { assetUrl, publicPaths } from './manifest.js';

export interface VitecacheOptions {
  /** Cache directory relative to the Vite project root; must be inside publicDir. */
  basePath?: string;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function status(error: unknown): number {
  if (error instanceof RequestError) return error.status;
  if (error instanceof ChangedDependenciesError) return 409;
  if (error instanceof MissingDependencyError) return 404;
  if (error instanceof OutsideRootError) return 403;
  if (error instanceof TypeError || error instanceof URIError) return 400;
  return 500;
}

function allowed(request: IncomingMessage): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === request.headers.host;
  } catch {
    return false;
  }
}

async function body(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const value of request) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk)) throw new RequestError(400, 'Expected a binary request body');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new RequestError(400, 'Expected valid JSON');
  }
}

function validate<T>(value: unknown, parser: (value: unknown) => T): T {
  try {
    return parser(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new RequestError(400, error.message);
  }
}

/** A save body: a 4-byte big-endian metadata length, that much JSON metadata, then the cached bytes. */
function upload(bytes: Uint8Array): { metadata: Record<string, unknown>; value: Uint8Array } {
  if (bytes.byteLength < 4) throw new RequestError(400, 'Expected a metadata length');
  const end = 4 + new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  if (end > bytes.byteLength) throw new RequestError(400, 'Truncated save metadata');
  const metadata = parse(new TextDecoder().decode(bytes.subarray(4, end)));
  if (typeof metadata !== 'object' || metadata === null || !('dependencies' in metadata) || !('hashes' in metadata) || !('saved' in metadata)) {
    throw new RequestError(400, 'Expected dependencies, hashes, and saved dependencies');
  }
  return { metadata, value: bytes.subarray(end) };
}

function json(response: ServerResponse, value: unknown): void {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  name: string,
  storage: Backend,
  server: ViteDevServer,
): Promise<void> {
  const root = server.config.root;
  response.setHeader('Cache-Control', 'no-store');
  if (name === '__vitecache' && request.method === 'GET') {
    json(response, { vitecache: 1 });
    return;
  }
  if ((name === '__vitecache/snapshot' || name === '__vitecache/resolve') && request.method === 'POST') {
    if (!allowed(request)) throw new RequestError(403, 'Cross-origin requests are forbidden');
    const value = parse(new TextDecoder().decode(await body(request)));
    if (typeof value !== 'object' || value === null || !('dependencies' in value)) {
      throw new RequestError(400, 'Expected dependencies');
    }
    if (name === '__vitecache/resolve') {
      const deps = validate(value.dependencies, dependencies);
      const origin = `${server.config.server.https ? 'https' : 'http'}://${request.headers.host}`;
      json(response, { dependencies: await resolveDependencies(server, deps, origin) });
      return;
    }
    const deps = validate(value.dependencies, resolvedDependencies);
    await confine(root, deps);
    json(response, await storage.snapshot(deps));
    return;
  }
  if (!/^[a-f0-9]{64}\.bin$/.test(name)) {
    response.statusCode = 404;
    response.end();
    return;
  }
  const key = name.slice(0, -4);
  if (request.method === 'PUT') {
    if (!allowed(request)) throw new RequestError(403, 'Cross-origin requests are forbidden');
    const { metadata, value } = upload(await body(request));
    const validation = validate(metadata.dependencies, resolvedDependencies);
    const expected = validate(metadata.hashes, hashes);
    const saved = validate(metadata.saved, (input) => resolvedDependencies(savedDependencies(input)));
    await confine(root, validation);
    await confine(root, saved);
    await storage.save(key, value, validation, expected, saved);
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, HEAD, PUT');
    response.end();
    return;
  }
  const stored = await storage.load(key, true);
  if (stored === undefined) {
    // Browsers log every 404 fetch as an error, and a miss is an expected answer.
    response.statusCode = 204;
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'application/octet-stream');
  response.setHeader('Content-Length', stored.bytes.byteLength);
  response.setHeader('X-Vitecache-Dependencies', encodeURIComponent(JSON.stringify(stored.hashes)));
  response.end(request.method === 'HEAD' ? undefined : stored.bytes);
}

/** Persist and validate entries in development; preserve asset URL mappings in production builds. */
export function vitecache(options: VitecacheOptions = {}): Plugin {
  let resolved: { backend: Backend; root: string; prefix: string; directory: string; config: ResolvedConfig; cachePath: string } | undefined;
  return {
    name: 'vitecache',
    enforce: 'post',
    async configResolved(config) {
      if (!config.publicDir) throw new Error('vitecache requires Vite publicDir');
      const { root, directory } = disk.location({ root: config.root, ...options });
      const path = relative(config.publicDir, directory);
      if (!path || !inside(config.publicDir, directory)) {
        throw new Error('vitecache basePath must be a directory inside Vite publicDir');
      }
      const base = new URL(config.base, 'http://vitecache').pathname.replace(/\/$/, '');
      resolved = {
        backend: createStorage({ root, ...options, memoizeHashes: config.command === 'serve' }),
        root,
        directory,
        config,
        cachePath: path.split(sep).join('/'),
        prefix: `${base}/${path.split(sep).map(encodeURIComponent).join('/')}/`,
      };
      await disk.ignore(root, directory);
    },
    async generateBundle(_options, bundle) {
      const storage = resolved;
      if (!storage) throw new Error('vitecache configuration was not resolved');
      const paths = new Map(Object.entries(await publicPaths(storage.config, storage.directory)));
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset') continue;
        const originals = [...new Set(asset.originalFileNames)];
        if (originals.length !== 1) continue;
        const original = originals[0];
        if (!original) continue;
        const file = relative(storage.root, resolve(storage.root, original));
        if (!inside(storage.root, resolve(storage.root, original))) continue;
        paths.set(assetUrl(asset.fileName), file.split(sep).join('/'));
      }
      const manifest = { paths: Object.fromEntries(paths), root: '../'.repeat(storage.cachePath.split('/').length + 1) };
      this.emitFile({ type: 'asset', fileName: `${storage.cachePath}/__vitecache/paths.json`, source: JSON.stringify(manifest) });
    },
    configureServer(server) {
      const storage = resolved;
      if (!storage) throw new Error('vitecache configuration was not resolved');
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://vitecache').pathname;
        if (!path.startsWith(storage.prefix)) {
          next();
          return;
        }
        void respond(request, response, path.slice(storage.prefix.length), storage.backend, server).catch((error: unknown) => {
          response.statusCode = status(error);
          if (error instanceof MissingDependencyError) {
            json(response, { error: 'missing-dependency', message: error.message });
            return;
          }
          response.setHeader('Content-Type', 'text/plain');
          response.end(error instanceof Error ? error.message : 'vitecache request failed');
        });
      });
    },
  };
}

export default vitecache;
