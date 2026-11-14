import { createHash } from 'node:crypto';
import { appendFile, readdir, readFile, rm } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, join, relative, resolve } from 'node:path';
import MagicString from 'magic-string';
import colors from 'picocolors';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import { createServer, normalizePath, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';
import { createNodeImportMeta, ESModulesEvaluator, ModuleRunner, type EvaluatedModules } from 'vite/module-runner';
import { cacheName, missing, read, type Warming } from './disk.js';
import { discover, type Load } from './discover.js';
import { current } from './inputs.js';

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

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Wraps each of the loads' inline functions in a tag of its identity, the hash of its importer and source, which keys
 * count it as.
 */
function tag(code: MagicString, loads: Load[], root: string): void {
  const importer = (load: Load) => normalizePath(relative(root, load.importer));
  for (const load of loads) {
    for (const { start, end } of load.functions) {
      const id = hash(`${importer(load)}\n${code.original.slice(start, end)}`);
      code.prependRight(start, 'Object.defineProperty(');
      code.appendLeft(end, `, Symbol.for("vitecache.function"), { value: ${JSON.stringify(id)} })`);
    }
  }
}

/**
 * The files of the modules reachable from `ids` in a module runner's graph of what it evaluated, which holds each
 * import as it ran, dynamic ones included. A package's module gives the package's package.json instead, whose version
 * covers its own imports.
 */
function reachable(modules: EvaluatedModules, ids: Iterable<string>): string[] {
  const files = new Set<string>();
  const seen = new Set<string>();
  const pending = [...ids];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    const module = modules.getModuleById(id);
    if (!module || seen.has(id)) continue;
    seen.add(id);
    // Built-in modules have no file, and virtual ones no absolute one, but a virtual module's imports still count.
    const file = isAbsolute(module.file) ? module.file : undefined;
    const installed = file && /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1];
    if (installed) {
      files.add(`${installed}/package.json`);
      continue;
    }
    if (file) files.add(file);
    pending.push(...module.imports);
  }
  return [...files];
}

/** The query of the module that exports a load's arguments, whose value is the load's position in its importer. */
const query = '?vitecache-load=';

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
 * load uses. In development it scans and warms at startup and again after every file change, and holds a request for an
 * entry whose inputs changed, or that does not exist, until warming finishes. A build scans and warms once.
 */
export function vitecache(): Plugin[] {
  /** Each scanned file with loads, and its loads. */
  const files = new Map<string, { code: string; loads: Load[] }>();
  let config: ResolvedConfig;
  const loaded = new Set<string>();
  let directory: string;
  /** Runs loaders: the dev server itself, or in a build a server started for that, once, by the first load. */
  let server: Promise<ViteDevServer> | undefined;
  /**
   * The plugin's own module runner on the server, whose graph records what each load ran. Not the environment's
   * runner, whose graph a full reload after a change clears while a load runs. And it asks the environment directly,
   * not over the hot channel, whose close removes the listener of its answers while closeBundle waits for the loads.
   */
  let runner: ModuleRunner | undefined;
  /** What the load being warmed uses, shared with CacheEntry through the global. */
  let warming: AsyncLocalStorage<Warming>;
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
      if (!/Cached\w*Loader/.test(code)) return void files.delete(file);
      const loads = discover(code, file);
      // Browsers run public scripts as they are, so nothing tags their functions.
      const inline = below(config.publicDir, file) === undefined ? undefined : loads.find((load) => load.functions[0]);
      if (inline)
        throw new Error(`Public scripts cannot pass inline functions to loads, at ${file}:${inline.position}`);
      files.set(file, { code, loads });
    } catch (error) {
      if (config.command === 'build') throw error;
      log(`${colors.red('cannot scan')} ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  /** Whether discovery scans `file`. */
  function scanned(file: string): boolean {
    return trees.some(({ root, matches }) => {
      const path = below(root, file);
      return path !== undefined && matches(path);
    });
  }

  /**
   * Serves each load's arguments as a module of its importer, so that its inline functions import as they do there, and
   * tags inline functions in the app's modules alike. The server a build warms with gets these hooks too.
   */
  const tagging: Plugin = {
    name: 'vitecache:tagging',
    enforce: 'pre',
    resolveId(id) {
      return id.includes(query) ? id : undefined;
    },
    // Vite invalidates the module when its importer changes, since it shares its file.
    load(id) {
      const [importer = '', position] = id.split(query);
      const file = files.get(importer);
      const load = file?.loads.find((load) => load.position === position);
      if (!file || !load) return undefined;
      const code = new MagicString(file.code);
      tag(code, [load], config.root);
      return `export default [${load.args.map(({ start, end }) => code.slice(start, end)).join(', ')}];`;
    },
    async transform(code, id) {
      if (id.includes('?') || !scanned(id) || !/Cached\w*Loader/.test(code)) return;
      let loads: Load[];
      try {
        loads = discover(code, id);
      } catch {
        // The scan reports it.
        return;
      }
      if (!loads.some((load) => load.functions.length)) return;
      // Warming hashes functions as the file holds them, which a plugin transforming before this one would change. Read
      // as Vite reads it, keeping a byte order mark.
      if (code !== (await readFile(id, 'utf8')))
        throw new Error(`vitecache must come before plugins that transform ${id}`);
      const tagged = new MagicString(code);
      tag(tagged, loads, config.root);
      return { code: tagged.toString(), map: tagged.generateMap({ hires: 'boundary', source: id }) };
    },
  };

  async function run({ importer, source, name, position }: Load): Promise<void> {
    server ??= createServer({
      configFile: config.configFile ?? false,
      root: config.root,
      mode: config.mode,
      logLevel: 'warn',
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      plugins: [{ name: warmServerMarker }, tagging],
    });
    const environment = (await server).environments.ssr;
    runner ??= new ModuleRunner(
      {
        transport: { invoke: (payload) => environment.hot.handleInvoke(payload) },
        createImportMeta: createNodeImportMeta,
        hmr: false,
        sourcemapInterceptor: false,
      },
      new ESModulesEvaluator(),
    );
    const { evaluatedModules } = runner;
    const resolved = await environment.pluginContainer.resolveId(source, importer);
    if (!resolved) throw new Error(`vitecache cannot resolve ${source} from ${importer}`);
    const module: Record<string, unknown> = await runner.import(resolved.id);
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
    const argumentsId = `${importer}${query}${position}`;
    const { default: args }: Record<string, unknown> = await runner.import(argumentsId);
    if (!Array.isArray(args)) throw new Error(`vitecache cannot load the arguments of ${name}`);
    // What the loader's module and the arguments' functions import, not the importer the arguments module shares.
    const modules = () =>
      reachable(evaluatedModules, [resolved.id, ...(evaluatedModules.getModuleById(argumentsId)?.imports ?? [])]);
    const { loadAsync } = instance;
    await warming.run({ files: new Set(), modules }, () => loadAsync.apply(instance, args));
  }

  /** Logs as Vite does with a timestamp, but tagged [vitecache], since Vite's own timestamp option tags lines [vite]. */
  function log(message: string, level: 'info' | 'error' = 'info'): void {
    const tag = colors.bold(level === 'info' ? colors.cyan('[vitecache]') : colors.red('[vitecache]'));
    config.logger[level](`${colors.dim(new Date().toLocaleTimeString())} ${tag} ${message}`);
  }

  /**
   * Runs every load once, all at once, so that one waiting on the GPU or a worker leaves the others to run, then,
   * unless a load failed, deletes the entries none of them loaded. A pass still running after half a second is
   * announced, and so is its end.
   */
  async function pass(): Promise<void> {
    queued = false;
    failed = false;
    loaded.clear();
    if (closing) return;
    const loads = [...files.values()].flatMap((file) => file.loads);
    const started = performance.now();
    let slow = false;
    const timer = setTimeout(() => {
      slow = true;
      log(`${colors.yellow('computing')} ${loads.length} loads…`);
    }, 500);
    await Promise.all(
      loads.map(async (load) => {
        try {
          await run(load);
        } catch (error) {
          failed = true;
          const file = normalizePath(relative(config.root, load.importer));
          log(
            `${colors.red('failed')} ${load.name} ${colors.dim(`${file}:${load.position}`)}\n${stack(error)}`,
            'error',
          );
        }
      }),
    );
    clearTimeout(timer);
    if (slow) log(`warmed in ${((performance.now() - started) / 1000).toFixed(1)} s`);
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

  // The warm server's copy of the plugin stays out, since this one warms, and gives it `tagging`.
  const apply: Plugin['apply'] = (config) =>
    !config.plugins?.some((plugin) => plugin && 'name' in plugin && plugin.name === warmServerMarker);
  return [
    { ...tagging, apply },
    {
      name: 'vitecache',
      apply,
      async configResolved(resolved) {
        config = resolved;
        if (!config.publicDir) throw new Error('vitecache requires Vite publicDir');
        // Its files are scanned as public scripts, so it cannot also hold the sources.
        if (`${config.root}/`.startsWith(`${config.publicDir}/`))
          throw new Error('vitecache requires a Vite publicDir that does not contain the root');
        // Normalized, as are the files hotUpdate is given.
        directory = normalizePath(join(config.publicDir, cacheName));
        // The same storage, so that a load an older plugin still warms records what it uses.
        warming = globalThis.vitecache?.warming ?? new AsyncLocalStorage<Warming>();
        globalThis.vitecache = { root: config.root, publicDir: config.publicDir, loaded, warming };
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
          await runner?.close();
          runner = undefined;
          await (await server)?.close();
          server = undefined;
        }
      },
      configureServer(devServer) {
        server = Promise.resolve(devServer);
        const prefix = `${config.base}${cacheName}/`;
        // Serves entries itself, since Vite's public file serving learns of new files only through its watcher: an entry
        // whose inputs are unchanged at once, any other once warming has saved or pruned it.
        devServer.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith(prefix)) return next();
          const name = new URL(request.url, 'http://vitecache').pathname.slice(prefix.length);
          const key = /^([a-f0-9]{64})\.bin$/.exec(name)?.[1];
          if (!key) return next();
          void current(config.root, directory, key)
            .then((fresh) => (fresh ? undefined : idle()))
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
        if (scanned(file)) await scan(file);
        // Any file can be an input, and an unchanged entry warms with one load. Saves are file changes too.
        void warm();
      },
      async closeBundle() {
        closing = true;
        await idle();
      },
    },
  ];
}
