import { appendFile, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import colors from 'picocolors';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import { createServer, normalizePath, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';
import { missing, read } from './disk.js';
import { discover, type Load } from './discover.js';
import { shared } from './shared.js';

/** Adds the cache directory to the project's .gitignore, since its entries are generated. */
async function ignore(root: string, directory: string): Promise<void> {
  const line = `${relative(root, directory).split('\\').join('/')}/*`;
  const file = join(root, '.gitignore');
  const contents = new TextDecoder().decode(await read(file));
  if (contents.split(/\r?\n/).includes(line)) return;
  await appendFile(file, `${contents && !contents.endsWith('\n') ? '\n' : ''}${line}\n`);
}

function stack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/** The JavaScript and TypeScript modules discovery scans, as Tailwind scans for class names. */
const modules = 'js,jsx,ts,tsx,mjs,mts';
/** The cache directory's name in publicDir, which is also its URL below Vite's base. */
const cacheName = '_vitecache';

export interface VitecacheOptions {
  /** Development: milliseconds an entry stays after the last load that used it, so that an undone edit reuses it. */
  pruneAfter?: number;
}

/**
 * Finds cached loader loads in the project's source files, and in publicDir's `.glts` scripts and every JavaScript and
 * TypeScript module there, and warms them in Node, so that browsers read what Node saved, then deletes the entries no
 * load uses. In development it scans and warms at startup and again after every file change, holds cache requests
 * until warming finishes, and deletes entries unused for `pruneAfter`. A build scans and warms once, checks that a
 * second pass saves nothing, and deletes every entry it did not use.
 */
export function vitecache({ pruneAfter = 60_000 }: VitecacheOptions = {}): Plugin {
  // The server a build runs loaders with loads the config, and so this plugin, again.
  if (shared.running) return { name: 'vitecache' };
  /** The loads each scanned file holds. */
  const files = new Map<string, Load[]>();
  let config: ResolvedConfig;
  let directory: string;
  /** Runs loaders: the dev server itself, or in a build a server started for that. */
  let server: ViteDevServer | undefined;
  let queue = Promise.resolve();
  /** Whether a pass is queued but has not started, which the next change then need not queue again. */
  let queued = false;
  /** When the latest pass started. Once the queue is idle, every load has used its entry since then. */
  let started = 0;
  let failed = false;
  /** Set once the dev server closes, after which a running pass stops and nothing is pruned. */
  let closing = false;
  let timer: NodeJS.Timeout | undefined;

  /** The directories discovery scans, with patterns relative to each: the root, and publicDir. */
  let trees: { root: string; pattern: string; excluded: string[]; matches: (path: string) => boolean }[];
  /** The path of a file in publicDir relative to it, undefined for any other file. */
  function publicPath(file: string): string | undefined {
    return file.startsWith(`${config.publicDir}/`) ? file.slice(config.publicDir.length + 1) : undefined;
  }

  /** Records a file's loads. Development logs failures, since a file being edited can fail to parse. */
  async function scan(file: string): Promise<void> {
    try {
      const code = new TextDecoder().decode(await read(file));
      if (/Cached\w*Loader/.test(code)) files.set(file, discover(code, file));
      else files.delete(file);
    } catch (error) {
      if (config.command === 'build') throw error;
      log(`${colors.red('cannot scan')} ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async function run({ importer, source, name, args }: Load): Promise<void> {
    if (!server) {
      shared.running = true;
      try {
        server = await createServer({
          configFile: config.configFile ?? false,
          root: config.root,
          mode: config.mode,
          logLevel: 'warn',
          server: { middlewareMode: true, hmr: false, ws: false, watch: null },
        });
      } finally {
        shared.running = false;
      }
    }
    const resolved = await server.environments.ssr.pluginContainer.resolveId(source, importer);
    if (!resolved) throw new Error(`vitecache cannot resolve ${source} from ${importer}`);
    const module: Record<string, unknown> = await server.ssrLoadModule(resolved.id);
    const exported = module[name];
    if (typeof exported !== 'function') throw new Error(`${source} does not export a class ${name}`);
    const instance: unknown = Reflect.construct(exported, []);
    const loadable = typeof instance === 'object' && instance !== null && 'loadAsync' in instance;
    if (!loadable || typeof instance.loadAsync !== 'function') throw new Error(`${name} has no loadAsync method`);
    const path = publicPath(importer);
    if (path !== undefined) {
      // A browser resolves a public file's relative URLs against its served URL, and a loader against its path. The
      // path leaves out Vite's base, so that keys do not depend on where the app is deployed.
      if (!('setPath' in instance) || typeof instance.setPath !== 'function')
        throw new Error(`${name} has no setPath method, which a load in a public file needs`);
      instance.setPath(`/${path.slice(0, path.lastIndexOf('/') + 1)}`);
    }
    await instance.loadAsync(...args);
  }

  /** Runs every load once, one at a time, logging progress and failures. */
  /** Logs as Vite does with a timestamp, but tagged [vitecache], since Vite's own timestamp option tags lines [vite]. */
  function log(message: string, level: 'info' | 'error' = 'info'): void {
    const tag = colors.bold(level === 'info' ? colors.cyan('[vitecache]') : colors.red('[vitecache]'));
    config.logger[level](`${colors.dim(new Date().toLocaleTimeString())} ${tag} ${message}`);
  }

  /** Runs every load once, one at a time. Hits are silent; a load that computes is logged, and announced when slow. */
  async function pass(): Promise<void> {
    queued = false;
    started = Date.now();
    for (const load of [...files.values()].flat()) {
      if (closing) return;
      const file = normalizePath(relative(config.root, load.importer));
      const where = `${load.name} ${colors.dim(`${file}:${load.position}`)}`;
      const start = Date.now();
      const saves = shared.saves;
      const slow = setTimeout(() => log(`${colors.yellow('computing')} ${where}…`), 500);
      try {
        await run(load);
      } catch (error) {
        failed = true;
        log(`${colors.red('failed')} ${where}\n${stack(error)}`, 'error');
        continue;
      } finally {
        clearTimeout(slow);
      }
      const computed = shared.saves - saves;
      if (!computed) continue;
      const time = Date.now() - start;
      const took = time < 1000 ? `${time} ms` : `${(time / 1000).toFixed(1)} s`;
      const entries = computed > 1 ? `, ${computed} entries` : '';
      log(`${colors.green('computed')} ${where} ${colors.dim(`in ${took}${entries}`)}`);
    }
  }

  /** Queues a pass unless one is already waiting. */
  function warm(): Promise<void> {
    if (!queued) {
      queued = true;
      queue = queue.then(pass);
    }
    return idle();
  }

  async function idle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = queue;
      await current;
    } while (current !== queue);
  }

  /** Deletes the entries no load used since `before`. */
  async function prune(before: number): Promise<void> {
    const names = await readdir(directory).catch((error: unknown) => {
      if (missing(error)) return [];
      throw error;
    });
    for (const name of names) {
      const key = /^([a-f0-9]{64})\.(?:bin|json)$/.exec(name)?.[1];
      if (key && (shared.used.get(key) ?? 0) < before) await rm(join(directory, name), { force: true });
    }
  }

  /** Prunes in development, once idle: entries the latest pass used stay, others until `pruneAfter` past their use. */
  async function expire(): Promise<void> {
    await idle();
    if (closing) return;
    await prune(Math.min(started, Date.now() - pruneAfter));
  }

  async function scanAll(): Promise<void> {
    for (const { root, pattern, excluded } of trees)
      for (const file of await glob(pattern, { cwd: root, absolute: true, ignore: excluded })) await scan(file);
  }

  return {
    name: 'vitecache',
    async configResolved(resolved) {
      config = resolved;
      if (!config.publicDir) throw new Error('vitecache requires Vite publicDir');
      // Its files are scanned as public scripts, so it cannot also hold the sources.
      if (`${config.root}/`.startsWith(`${config.publicDir}/`))
        throw new Error('vitecache requires a Vite publicDir that does not contain the root');
      // Normalized, as are the files hotUpdate is given.
      directory = normalizePath(join(config.publicDir, cacheName));
      shared.root = config.root;
      shared.directory = directory;
      const outputs = [config.build.outDir, config.publicDir].map((path) =>
        relative(config.root, resolve(config.root, path)),
      );
      const tree = (root: string, pattern: string, excluded: string[]) => ({
        root,
        pattern,
        excluded,
        matches: picomatch(pattern, { ignore: excluded }),
      });
      trees = [
        // Not dependencies or outputs. An output at the root itself excludes nothing, since the root holds the sources.
        tree(config.root, `**/*.{${modules}}`, [
          '**/node_modules/**',
          ...outputs.filter(Boolean).map((path) => `${normalizePath(path)}/**`),
        ]),
        // .glts scripts and every JavaScript and TypeScript module in publicDir.
        tree(config.publicDir, `**/*.{glts,${modules}}`, ['**/node_modules/**', `${cacheName}/**`]),
      ];
      await ignore(config.root, directory);
    },
    async buildStart() {
      if (config.command !== 'build' || this.environment.name !== 'client') return;
      const start = Date.now();
      failed = false;
      try {
        await scanAll();
        await warm();
        if (failed) throw new Error('vitecache: warming failed, see the errors above.');
        const saves = shared.saves;
        await warm();
        if (failed) throw new Error('vitecache: warming failed, see the errors above.');
        if (shared.saves !== saves)
          throw new Error('vitecache: a second warming saved entries again, so their keys are not stable.');
      } finally {
        await server?.close();
        server = undefined;
      }
      await prune(start);
    },
    configureServer(devServer) {
      server = devServer;
      const prefix = `${config.base}${cacheName}/`;
      // Serves entries itself, after warming: Vite's public file serving learns of new files only through its watcher.
      devServer.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(prefix)) return next();
        const name = new URL(request.url, 'http://vitecache').pathname.slice(prefix.length);
        if (!/^[a-f0-9]{64}\.bin$/.test(name)) return next();
        void idle()
          .then(() => read(join(directory, name)))
          .then((bytes) => {
            if (!bytes) return next();
            response.setHeader('Content-Type', 'application/octet-stream');
            response.setHeader('Cache-Control', 'no-cache');
            response.end(bytes);
          }, next);
      });
      const report = (error: unknown) => log(stack(error), 'error');
      // Queued, so that requests wait for the scan too.
      queue = queue.then(scanAll).catch(report);
      void warm().then(expire).catch(report);
      timer = setInterval(() => void expire().catch(report), pruneAfter);
    },
    async hotUpdate({ file }) {
      if (this.environment.name !== 'client' || file.startsWith(directory)) return;
      const scanned = ({ root, matches }: (typeof trees)[number]) =>
        file.startsWith(`${root}/`) && matches(file.slice(root.length + 1));
      if (trees.some(scanned)) await scan(file);
      // Any file can be an input, and an unchanged entry warms with one load. Saves are file changes too.
      void warm();
    },
    async closeBundle() {
      closing = true;
      clearInterval(timer);
      await idle();
    },
  };
}
