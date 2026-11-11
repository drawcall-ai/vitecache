import { appendFile, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import colors from 'picocolors';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import { createServer, normalizePath, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';
import { cacheName, missing, read } from './disk.js';
import { discover, type Load } from './discover.js';

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

/** The extensions of the JavaScript and TypeScript modules discovery scans, as Tailwind scans for class names. */
const extensions = 'js,jsx,ts,tsx,mjs,mts';

/** A directory discovery scans, with patterns relative to it. */
interface Tree {
  root: string;
  pattern: string;
  excluded: string[];
  matches: (path: string) => boolean;
}

/** The path of `file` relative to `directory`, undefined for a file outside it. Both are normalized. */
function below(directory: string, file: string): string | undefined {
  return file.startsWith(`${directory}/`) ? file.slice(directory.length + 1) : undefined;
}

/** Marks the server the plugin warms with in a build, which loads the config, and so the plugin, again. */
const warmServerMarker = 'vitecache:warm';

/**
 * Finds cached loader loads in the project's source files, and in publicDir's `.glts` scripts and every JavaScript and
 * TypeScript module there, and warms them in Node, so that browsers read what Node saved, then deletes the entries no
 * load uses. In development it scans and warms at startup and again after every file change, and holds cache requests
 * until warming finishes. A build scans and warms once.
 */
export function vitecache(): Plugin {
  /** The loads each scanned file holds. */
  const files = new Map<string, Load[]>();
  let config: ResolvedConfig;
  const loaded = new Set<string>();
  let directory: string;
  /** Runs loaders: the dev server itself, or in a build a server started for that. */
  let server: ViteDevServer | undefined;
  let queue = Promise.resolve();
  /** Whether a pass is queued but has not started, which the next change then need not queue again. */
  let queued = false;
  /** Whether a load of the latest pass failed, which leaves the entries in place. */
  let failed = false;
  /** Set once the dev server closes, after which a running pass stops and nothing is pruned. */
  let closing = false;

  /** The directories discovery scans, with patterns relative to each: the root, and publicDir. */
  let trees: Tree[];

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
      server = await createServer({
        configFile: config.configFile ?? false,
        root: config.root,
        mode: config.mode,
        logLevel: 'warn',
        server: { middlewareMode: true, hmr: false, ws: false, watch: null },
        plugins: [{ name: warmServerMarker }],
      });
    }
    const resolved = await server.environments.ssr.pluginContainer.resolveId(source, importer);
    if (!resolved) throw new Error(`vitecache cannot resolve ${source} from ${importer}`);
    const module: Record<string, unknown> = await server.ssrLoadModule(resolved.id);
    const exported = module[name];
    if (typeof exported !== 'function') throw new Error(`${source} does not export a class ${name}`);
    const instance: unknown = Reflect.construct(exported, []);
    const loadable = typeof instance === 'object' && instance !== null && 'loadAsync' in instance;
    if (!loadable || typeof instance.loadAsync !== 'function') throw new Error(`${name} has no loadAsync method`);
    const path = below(config.publicDir, importer);
    if (path !== undefined) {
      // A browser resolves a public file's relative URLs against its served URL, and a loader against its path. The
      // path leaves out Vite's base, so that keys do not depend on where the app is deployed.
      if (!('setPath' in instance) || typeof instance.setPath !== 'function')
        throw new Error(`${name} has no setPath method, which a load in a public file needs`);
      // Encoded by the URL parser, as a browser requests it; it would read these as delimiters or escapes.
      const folder = path.slice(0, path.lastIndexOf('/') + 1).replace(/[%#?\\]/g, encodeURIComponent);
      instance.setPath(new URL(`/${folder}`, 'http://host').pathname);
    }
    await instance.loadAsync(...args);
  }

  /** Logs as Vite does with a timestamp, but tagged [vitecache], since Vite's own timestamp option tags lines [vite]. */
  function log(message: string, level: 'info' | 'error' = 'info'): void {
    const tag = colors.bold(level === 'info' ? colors.cyan('[vitecache]') : colors.red('[vitecache]'));
    config.logger[level](`${colors.dim(new Date().toLocaleTimeString())} ${tag} ${message}`);
  }

  /**
   * Runs every load once, one at a time, then, unless a load failed, deletes the entries none of them loaded. A load
   * still running after half a second is announced.
   */
  async function pass(): Promise<void> {
    queued = false;
    failed = false;
    loaded.clear();
    for (const load of [...files.values()].flat()) {
      if (closing) return;
      const file = normalizePath(relative(config.root, load.importer));
      const where = `${load.name} ${colors.dim(`${file}:${load.position}`)}`;
      const slow = setTimeout(() => log(`${colors.yellow('computing')} ${where}…`), 500);
      try {
        await run(load);
      } catch (error) {
        failed = true;
        log(`${colors.red('failed')} ${where}\n${stack(error)}`, 'error');
      } finally {
        clearTimeout(slow);
      }
    }
    // Another plugin in this process may have replaced the global since, as a restarted dev server does.
    if (failed || closing || globalThis.vitecache?.loaded !== loaded) return;
    try {
      await prune();
    } catch (error) {
      if (config.command === 'build') throw error;
      log(`${colors.red('cannot prune')} ${stack(error)}`, 'error');
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

  /** Deletes the entries whose keys are not in `loaded`. */
  async function prune(): Promise<void> {
    const names = await readdir(directory).catch((error: unknown) => {
      if (missing(error)) return [];
      throw error;
    });
    for (const name of names) {
      const key = /^([a-f0-9]{64})\.(?:bin|json)$/.exec(name)?.[1];
      if (key && !loaded.has(key)) await rm(join(directory, name), { force: true });
    }
  }

  async function scanAll(): Promise<void> {
    for (const { root, pattern, excluded } of trees)
      for (const file of await glob(pattern, { cwd: root, absolute: true, ignore: excluded })) await scan(file);
  }

  return {
    name: 'vitecache',
    // The warm server's copy of the plugin stays out, since this one warms.
    apply: (config) =>
      !config.plugins?.some((plugin) => plugin && 'name' in plugin && plugin.name === warmServerMarker),
    async configResolved(resolved) {
      config = resolved;
      if (!config.publicDir) throw new Error('vitecache requires Vite publicDir');
      // Its files are scanned as public scripts, so it cannot also hold the sources.
      if (`${config.root}/`.startsWith(`${config.publicDir}/`))
        throw new Error('vitecache requires a Vite publicDir that does not contain the root');
      // Normalized, as are the files hotUpdate is given.
      directory = normalizePath(join(config.publicDir, cacheName));
      globalThis.vitecache = { root: config.root, publicDir: config.publicDir, loaded };
      const outputs = [config.build.outDir, config.publicDir].map((path) =>
        relative(config.root, resolve(config.root, path)),
      );
      const tree = (root: string, pattern: string, excluded: string[]): Tree => ({
        root,
        pattern,
        excluded,
        matches: picomatch(pattern, { ignore: excluded }),
      });
      trees = [
        // Not dependencies or outputs. An output at the root itself excludes nothing, since the root holds the sources.
        tree(config.root, `**/*.{${extensions}}`, [
          '**/node_modules/**',
          ...outputs.filter(Boolean).map((path) => `${normalizePath(path)}/**`),
        ]),
        tree(config.publicDir, `**/*.{glts,${extensions}}`, ['**/node_modules/**', `${cacheName}/**`]),
      ];
      await ignore(config.root, directory);
    },
    async buildStart() {
      if (config.command !== 'build' || this.environment.name !== 'client') return;
      try {
        await scanAll();
        await warm();
        if (failed) throw new Error('vitecache: warming failed, see the errors above.');
      } finally {
        await server?.close();
        server = undefined;
      }
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
      void warm().catch(report);
    },
    async hotUpdate({ file }) {
      if (this.environment.name !== 'client' || file.startsWith(directory)) return;
      const scanned = trees.some(({ root, matches }) => {
        const path = below(root, file);
        return path !== undefined && matches(path);
      });
      if (scanned) await scan(file);
      // Any file can be an input, and an unchanged entry warms with one load. Saves are file changes too.
      void warm();
    },
    async closeBundle() {
      closing = true;
      await idle();
    },
  };
}
