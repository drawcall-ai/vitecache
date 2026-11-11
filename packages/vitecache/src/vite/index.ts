import { relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import * as disk from '../disk.js';
import { createStorage } from '../storage.js';
import type { Storage } from '../storage.js';
import { dependencies, MissingDependencyError } from '../dependencies.js';
import type { Dependencies } from '../types.js';
import { RequestError, resolveDependencies } from './resolve.js';
import { assetUrl, publicPaths } from './manifest.js';

export interface VitecacheOptions {
  /** Cache directory relative to the Vite project root; must be inside publicDir. */
  basePath?: string;
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

/** The `dependencies` of a same-origin POST's JSON body. */
async function posted(request: IncomingMessage): Promise<Dependencies> {
  if (!allowed(request)) throw new RequestError(403, 'Cross-origin requests are forbidden');
  const chunks: Uint8Array[] = [];
  for await (const value of request) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk)) throw new RequestError(400, 'Expected a binary request body');
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'Expected valid JSON');
  }
  if (typeof body !== 'object' || body === null || !('dependencies' in body)) throw new RequestError(400, 'Expected dependencies');
  try {
    return dependencies(body.dependencies);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new RequestError(400, error.message);
  }
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
}

/** Serves the cache directory: discovery, URL resolution, and entries that are hits only while their inputs are current. */
async function respond(request: IncomingMessage, response: ServerResponse, name: string, storage: Storage, server: ViteDevServer): Promise<void> {
  response.setHeader('Cache-Control', 'no-store');
  if (name === '__vitecache' && request.method === 'GET') {
    sendJson(response, { vitecache: 1 });
    return;
  }
  if (name === '__vitecache/resolve' && request.method === 'POST') {
    const declared = await posted(request);
    const origin = `${server.config.server.https ? 'https' : 'http'}://${request.headers.host}`;
    sendJson(response, { dependencies: await resolveDependencies(server, declared, origin) });
    return;
  }
  if (!/^[a-f0-9]{64}\.bin$/.test(name)) {
    response.statusCode = 404;
    response.end();
    return;
  }
  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET');
    response.end();
    return;
  }
  const stored = await storage.load(name.slice(0, -4));
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
  if (request.headers['if-none-match'] === tag) {
    response.statusCode = 304;
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'application/octet-stream');
  response.setHeader('Content-Length', stored.bytes.byteLength);
  response.end(stored.bytes);
}

/** Serves checked entries in development; preserves asset URL mappings in production builds. */
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
          response.statusCode = error instanceof RequestError ? error.status : 500;
          response.setHeader('Content-Type', 'text/plain');
          response.end(error instanceof Error ? error.message : 'vitecache request failed');
        });
      });
    },
  };
}

export default vitecache;
