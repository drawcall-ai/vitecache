import { relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import * as disk from '../disk.js';
import { createStorage } from '../storage.js';
import type { Storage } from '../storage.js';
import { ChangedDependenciesError, dependencies, hashableDependencies, hashes, MissingDependencyError } from '../dependencies.js';
import { confine, RequestError, resolveDependencies } from './resolve.js';
import { assetUrl, publicPaths } from './manifest.js';

export interface VitecacheOptions {
  /** Cache directory relative to the Vite project root; must be inside publicDir. */
  basePath?: string;
}

function status(error: unknown): number {
  if (error instanceof RequestError) return error.status;
  if (error instanceof ChangedDependenciesError) return 409;
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

function parseRequest<T>(value: unknown, parser: (value: unknown) => T): T {
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
  if (typeof metadata !== 'object' || metadata === null || !('checked' in metadata) || !('expected' in metadata) || !('saved' in metadata)) {
    throw new RequestError(400, 'Expected checked, expected, and saved');
  }
  return { metadata, value: bytes.subarray(end) };
}

/** The `dependencies` of a same-origin POST's JSON body. */
async function posted(request: IncomingMessage): Promise<unknown> {
  if (!allowed(request)) throw new RequestError(403, 'Cross-origin requests are forbidden');
  const value = parse(new TextDecoder().decode(await body(request)));
  if (typeof value !== 'object' || value === null || !('dependencies' in value)) throw new RequestError(400, 'Expected dependencies');
  return value.dependencies;
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  name: string,
  storage: Storage,
  server: ViteDevServer,
): Promise<void> {
  const root = server.config.root;
  response.setHeader('Cache-Control', 'no-store');
  if (name === '__vitecache' && request.method === 'GET') {
    sendJson(response, { vitecache: 1 });
    return;
  }
  if (name === '__vitecache/resolve' && request.method === 'POST') {
    const deps = parseRequest(await posted(request), dependencies);
    const origin = `${server.config.server.https ? 'https' : 'http'}://${request.headers.host}`;
    sendJson(response, { dependencies: await resolveDependencies(server, deps, origin) });
    return;
  }
  if (name === '__vitecache/snapshot' && request.method === 'POST') {
    const deps = parseRequest(await posted(request), hashableDependencies);
    await confine(root, deps);
    sendJson(response, await storage.snapshot(deps));
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
    const checked = parseRequest(metadata.checked, hashableDependencies);
    const expected = parseRequest(metadata.expected, hashes);
    const saved = parseRequest(metadata.saved, hashableDependencies);
    await confine(root, checked);
    await confine(root, saved);
    await storage.save(key, value, { checked, expected, saved });
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, PUT');
    response.end();
    return;
  }
  const stored = await storage.load(key);
  if (stored === undefined) {
    // Browsers log every 404 fetch as an error, and a miss is an expected answer.
    response.statusCode = 204;
    response.end();
    return;
  }
  // Browsers keep the bytes and revalidate them on every load, so an unchanged entry costs a 304 rather than a download.
  response.setHeader('Cache-Control', 'no-cache');
  const tag = `"${stored.tag}"`;
  response.setHeader('ETag', tag);
  response.setHeader('X-Vitecache-Dependencies', encodeURIComponent(JSON.stringify(stored.hashes)));
  if (request.headers['if-none-match'] === tag) {
    response.statusCode = 304;
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'application/octet-stream');
  response.setHeader('Content-Length', stored.bytes.byteLength);
  response.end(stored.bytes);
}

/** Persist and validate entries in development; preserve asset URL mappings in production builds. */
export function vitecache(options: VitecacheOptions = {}): Plugin {
  let state: { storage: Storage; root: string; prefix: string; directory: string; config: ResolvedConfig; cachePath: string } | undefined;
  return {
    name: 'vitecache',
    enforce: 'post',
    async configResolved(config) {
      if (!config.publicDir) throw new Error('vitecache requires Vite publicDir');
      const { root, directory } = disk.location({ root: config.root, ...options });
      const path = relative(config.publicDir, directory);
      if (!path || !disk.inside(config.publicDir, directory)) {
        throw new Error('vitecache basePath must be a directory inside Vite publicDir');
      }
      const base = new URL(config.base, 'http://vitecache').pathname.replace(/\/$/, '');
      state = {
        storage: createStorage({ root, ...options }),
        root,
        directory,
        config,
        cachePath: path.split(sep).join('/'),
        prefix: `${base}/${path.split(sep).map(encodeURIComponent).join('/')}/`,
      };
      await disk.ignore(root, directory);
    },
    async generateBundle(_options, bundle) {
      const resolved = state;
      if (!resolved) throw new Error('vitecache configuration was not resolved');
      const paths = new Map(Object.entries(await publicPaths(resolved.config, resolved.directory)));
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset') continue;
        const originals = [...new Set(asset.originalFileNames)];
        if (originals.length !== 1) continue;
        const original = originals[0];
        if (!original) continue;
        const file = resolve(resolved.root, original);
        if (!disk.inside(resolved.root, file)) continue;
        paths.set(assetUrl(asset.fileName), relative(resolved.root, file).split(sep).join('/'));
      }
      const manifest = { paths: Object.fromEntries(paths), root: '../'.repeat(resolved.cachePath.split('/').length + 1) };
      this.emitFile({ type: 'asset', fileName: `${resolved.cachePath}/__vitecache/paths.json`, source: JSON.stringify(manifest) });
    },
    configureServer(server) {
      const resolved = state;
      if (!resolved) throw new Error('vitecache configuration was not resolved');
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://vitecache').pathname;
        if (!path.startsWith(resolved.prefix)) {
          next();
          return;
        }
        void respond(request, response, path.slice(resolved.prefix.length), resolved.storage, server).catch((error: unknown) => {
          // A missing dependency is an expected answer, as in a snapshot: a body, and no error status for browsers to log.
          if (error instanceof MissingDependencyError) {
            sendJson(response, { status: 'missing', message: error.message });
            return;
          }
          response.statusCode = status(error);
          response.setHeader('Content-Type', 'text/plain');
          response.end(error instanceof Error ? error.message : 'vitecache request failed');
        });
      });
    },
  };
}

export default vitecache;
