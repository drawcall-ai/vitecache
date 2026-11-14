import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { build, createLogger, createServer, type ViteDevServer } from 'vite';
import { key } from '../src/entry.js';
import { CacheEntry } from '../src/node.js';

const servers: ViteDevServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A project whose page runs `main`, with a cached loader that saves its arguments, the contents of input.txt and what
 * an inline `transform` function returns, and
 * logs each run outside the watched files, and one that keys on the URL it loads, resolved against its path, and saves
 * that path, with the public file as an input.
 */
async function project(main: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vitecache-vite-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(
    join(root, 'vite.config.js'),
    `
    import { vitecache } from ${JSON.stringify(resolve('src/vite.ts'))};
    export default { logLevel: 'silent', plugins: [vitecache()] };`,
  );
  await writeFile(join(root, 'index.html'), '<script type="module" src="/src/main.js"></script>');
  await writeFile(join(root, 'input.txt'), 'a');
  await writeFile(
    join(root, 'src/loader.js'),
    `
    import { appendFile, readFile } from 'node:fs/promises';
    import { CacheEntry } from ${JSON.stringify(resolve('src/node.ts'))};
    export class CachedEchoLoader {
      async loadAsync(value) {
        await appendFile(new URL('../node_modules/runs.txt', import.meta.url), 'run\\n');
        const dependencies = { value: { value }, input: { path: 'input.txt' } };
        const entry = new CacheEntry({ version: 'echo@1', dependencies });
        if (await entry.load()) return;
        const input = await readFile(new URL('../input.txt', import.meta.url), 'utf8');
        const transformed = typeof value?.transform === 'function' ? await value.transform() : '';
        await entry.save(new TextEncoder().encode(JSON.stringify(value) + input + transformed));
      }
    }`,
  );
  await writeFile(
    join(root, 'src/located.js'),
    `
    import { CacheEntry, publicURL } from ${JSON.stringify(resolve('src/node.ts'))};
    export class CachedLocatedLoader {
      setPath(path) { this.path = path; }
      async loadAsync(url) {
        const resolved = new URL(url, new URL(this.path, 'http://host')).pathname;
        const entry = new CacheEntry({ version: 'located@1', dependencies: { url: { value: resolved } } });
        if (await entry.load()) return;
        // Fails unless publicURL finds the file below the plugin's publicDir, which it records as an input.
        await fetch(publicURL(resolved));
        await entry.save(new TextEncoder().encode(this.path));
      }
    }`,
  );
  await writeFile(join(root, 'src/main.js'), `import { CachedEchoLoader as Echo } from './loader.js';\n${main}`);
  return root;
}

/** A public/tree/index.glts that imports Loader as `imported` says, and loads in TypeScript on one with an argument. */
const script = (imported: string) =>
  `${imported}
const manager: object = {};
await new Loader(manager).loadAsync('./model.glts');`;

const locatedImport = "import { CachedLocatedLoader as Loader } from '../../src/located.js';";

const located = (url: string) => key({ version: 'located@1', dependencies: { url: { value: url } } });

const runs = async (root: string) =>
  (await readFile(join(root, 'node_modules/runs.txt'), 'utf8')).split('\n').length - 1;

test('a build warms every call, deploys the entries, and prunes the rest', async () => {
  const root = await project(`
    import * as loaders from './loader.js';
    const options = { Echo: 1 };
    options.Echo;
    class Names { Echo() {} static Echo = 1; }
    await new Echo().loadAsync({ n: -1, list: [true, null, 'x'] });
    await new loaders.CachedEchoLoader(Date.now()).loadAsync('x');
    const later = () => echo.loadAsync(2);
    const echo = new Echo();
    await later();`);
  await mkdir(join(root, 'public/_vitecache'), { recursive: true });
  await writeFile(join(root, 'public/_vitecache', `${'0'.repeat(64)}.bin`), 'stale');
  await writeFile(join(root, 'public/_vitecache', `${'0'.repeat(64)}.json`), '{}');
  await build({ root });
  const deployed = await readdir(join(root, 'dist/_vitecache'));
  expect(deployed).toHaveLength(6);
  const contents = await Promise.all(
    deployed
      .filter((file) => file.endsWith('.bin'))
      .map((file) => readFile(join(root, 'dist/_vitecache', file), 'utf8')),
  );
  expect(contents.sort()).toEqual(['"x"a', '2a', '{"n":-1,"list":[true,null,"x"]}a']);
  expect(await readdir(join(root, 'public/_vitecache'))).toEqual(deployed);
  // The warm server's own copy of the plugin warms nothing.
  expect(await runs(root)).toBe(3);
});

test.each(['/', '/app/', './'])("a build with base %s warms public scripts, setting loaders' paths", async (base) => {
  const root = await project('');
  // A browser requests a space encoded and an @ literal, and so keys on that path.
  const tree = join(root, 'public/@scope/my tree');
  await mkdir(tree, { recursive: true });
  await writeFile(join(tree, 'index.glts'), script(locatedImport.replace('../../', '../../../')));
  await writeFile(join(tree, 'model.glts'), '');
  await writeFile(join(root, 'public/@scope/helper.bin'), '');
  await writeFile(
    join(tree, 'helper.js'),
    "import { CachedLocatedLoader as L } from '../../../src/located.js'; new L().loadAsync('../helper.bin');",
  );
  // The cache directory is not scanned: this misuse would fail the build.
  await mkdir(join(root, 'public/_vitecache'));
  await writeFile(join(root, 'public/_vitecache/misuse.js'), "import { CachedLocatedLoader as L } from 'x'; [L];");
  await build({ root, base });
  const urls = ['/@scope/my%20tree/model.glts', '/@scope/helper.bin'];
  const contents = await Promise.all(
    urls.map((url) => readFile(join(root, 'dist/_vitecache', `${located(url)}.bin`), 'utf8')),
  );
  expect(contents).toEqual(['/@scope/my%20tree/', '/@scope/my%20tree/']);
});

test('a build fails on a load in a public script whose loader has no setPath', async () => {
  const root = await project('');
  await mkdir(join(root, 'public/tree'), { recursive: true });
  const imported = "import { CachedEchoLoader as Loader } from '../../src/loader.js';";
  await writeFile(join(root, 'public/tree/index.glts'), script(imported));
  const stale = join(root, 'public/_vitecache', `${'0'.repeat(64)}.bin`);
  await mkdir(join(root, 'public/_vitecache'));
  await writeFile(stale, 'stale');
  const errors: string[] = [];
  const customLogger = { ...createLogger('silent'), error: (message: string) => void errors.push(message) };
  await expect(build({ root, customLogger })).rejects.toThrow(/warming failed/);
  // A failed warming deletes nothing.
  expect(await readFile(stale, 'utf8')).toBe('stale');
  expect(errors.join('\n').replace(/\x1b\[\d+m/g, '')).toMatch(/public\/tree\/index\.glts:3:7\n.*no setPath/);
});

/** A project whose load passes a function importing part.js, which imports deep.js and the package engine. */
async function functionProject() {
  const root = await project("import './parts.ts';");
  await writeFile(join(root, 'src/part.js'), "export { part } from './deep.js'; export { engine } from 'engine';");
  await writeFile(join(root, 'src/deep.js'), "export const part = 'p';");
  await mkdir(join(root, 'node_modules/engine'));
  await writeFile(join(root, 'node_modules/engine/package.json'), '{ "name": "engine", "version": "1.0.0" }');
  await writeFile(join(root, 'node_modules/engine/index.js'), "export const engine = 'E';");
  await writeFile(
    join(root, 'src/parts.ts'),
    `
    import { CachedEchoLoader } from './loader.js';
    await new CachedEchoLoader().loadAsync({
      n: 1,
      transform: async (): Promise<string> => {
        const { part, engine } = await import('./part.js');
        return part + engine;
      },
    });`,
  );
  const cache = join(root, 'public/_vitecache');
  const files = async (extension: string) =>
    (await readdir(cache)).filter((file) => file.endsWith(extension)).map((file) => join(cache, file));
  const saved = async () => Promise.all((await files('.bin')).map((file) => readFile(file, 'utf8')));
  return { root, files, saved };
}

test('a load records what it ran as inputs, and a build computes it again once one changes', async () => {
  const { root, files, saved } = await functionProject();
  await build({ root });
  expect(await saved()).toEqual(['{"n":1}apE']);
  const [metadata = ''] = await files('.json');
  const { inputs } = JSON.parse(await readFile(metadata, 'utf8'));
  // The loader's module and what the function ran, not the importer of the load. The loader also runs vitecache's
  // sources here, which an app installs as a package.
  const recorded = inputs.map((input: { dependency: object }) => input.dependency);
  expect(recorded).toEqual(
    expect.arrayContaining([
      { path: 'input.txt' },
      { path: 'src/loader.js' },
      { path: 'src/part.js' },
      { path: 'src/deep.js' },
      { path: 'node_modules/engine/package.json' },
    ]),
  );
  expect(recorded).not.toContainEqual({ path: 'src/parts.ts' });
  expect(recorded).not.toContainEqual({ path: 'node_modules/engine/index.js' });
  await writeFile(join(root, 'src/deep.js'), "export const part = 'q';");
  await build({ root });
  expect(await saved()).toEqual(['{"n":1}aqE']);
});

test('a build fails when a module the load ran changes while the result is computed', async () => {
  const { root } = await functionProject();
  await writeFile(
    join(root, 'src/parts.ts'),
    `
    import { CachedEchoLoader } from './loader.js';
    await new CachedEchoLoader().loadAsync({
      n: 1,
      transform: async (): Promise<string> => {
        const { part } = await import('./part.js');
        const { writeFile } = await import('node:fs/promises');
        await writeFile(new URL('./deep.js', import.meta.url), "export const part = 'q';");
        return part;
      },
    });`,
  );
  const errors: string[] = [];
  const customLogger = { ...createLogger('silent'), error: (message: string) => void errors.push(message) };
  await expect(build({ root, customLogger })).rejects.toThrow(/warming failed/);
  expect(errors.join('\n')).toMatch(/changed while the result was computed: \{"path":"src\/deep\.js"\}/);
});

test('inline functions key alike in the browser and in Node, where the app hits what warming saved', async () => {
  const { root, files } = await functionProject();
  await build({ root });
  const server = await createServer({ root, server: { middlewareMode: true, hmr: false, ws: false } });
  servers.push(server);
  const id = async (environment: 'client' | 'ssr') =>
    /value: "(\w+)"/.exec((await server.environments[environment].transformRequest('/src/parts.ts'))?.code ?? '')?.[1];
  expect(await id('client')).toMatch(/^[0-9a-f]{64}$/);
  expect(await id('client')).toBe(await id('ssr'));
  const [entry = ''] = await files('.bin');
  const inode = (await stat(entry)).ino;
  await server.ssrLoadModule('/src/parts.ts');
  expect((await stat(entry)).ino).toBe(inode);
});

test('the dev server warms again when a module the load ran changes, and records what it newly runs', async () => {
  const { root, saved } = await functionProject();
  const server = await createServer({ root, server: { port: 0 } });
  servers.push(server);
  await server.listen();
  await vi.waitFor(async () => expect(await saved()).toEqual(['{"n":1}apE']), { timeout: 10_000 });
  await writeFile(join(root, 'src/deep.js'), "export { part } from './deeper.js';");
  await writeFile(join(root, 'src/deeper.js'), "export const part = 'r';");
  await vi.waitFor(async () => expect(await saved()).toEqual(['{"n":1}arE']), { timeout: 10_000 });
  await writeFile(join(root, 'src/deeper.js'), "export const part = 's';");
  await vi.waitFor(async () => expect(await saved()).toEqual(['{"n":1}asE']), { timeout: 10_000 });
});

test('a build fails on an inline function in a public script', async () => {
  const root = await project('');
  await mkdir(join(root, 'public/tree'), { recursive: true });
  const imported = "import { CachedLocatedLoader as Loader } from '../../src/located.js';";
  await writeFile(join(root, 'public/tree/index.glts'), `${imported}\nnew Loader().loadAsync(() => 1);`);
  await expect(build({ root })).rejects.toThrow(/Public scripts cannot pass inline functions/);
});

test.each([
  ['a non-literal argument', 'new Echo().loadAsync(Date.now());', /literal JSON/],
  ['a loader passed around', 'const echo = new Echo(); [echo];', /loadAsync/],
  ['an exported loader variable', 'export const echo = new Echo();', /loadAsync/],
  ['a re-exported loader variable', 'const echo = new Echo(); export { echo };', /loadAsync/],
  ['another method of a loader', 'const echo = new Echo(); echo.setPath("x");', /loadAsync/],
  ['a subclass', 'class Loud extends Echo {}', /loadAsync/],
])('a build fails on %s', async (_, main, error) => {
  await expect(build({ root: await project(main) })).rejects.toThrow(error);
});

test('the dev server warms every load at startup, holds requests for it, and warms and prunes after changes', async () => {
  const root = await project('new Echo().loadAsync(1);');
  const cache = join(root, 'public/_vitecache');
  const stale = `${'0'.repeat(64)}.bin`;
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, stale), 'stale');
  // Otherwise the plugin appends to it, and the watcher can report that write as a change after starting.
  await writeFile(join(root, '.gitignore'), 'public/_vitecache/*\n');
  const server = await createServer({ root, server: { port: 0 } });
  servers.push(server);
  await server.listen();
  const name = (value: number) =>
    key({ version: 'echo@1', dependencies: { value: { value }, input: { path: 'input.txt' } } });
  const url = (value: number) => `${server.resolvedUrls?.local[0]}_vitecache/${name(value)}.bin`;
  // No module was requested: the startup scan found the load.
  const response = await fetch(url(1));
  expect(response.headers.get('content-type')).toBe('application/octet-stream');
  expect(await response.text()).toBe('1a');
  expect(await readdir(cache)).not.toContain(stale);
  // The save's own files do not warm again.
  await new Promise((done) => setTimeout(done, 500));
  expect(await runs(root)).toBe(1);
  await writeFile(join(root, 'input.txt'), 'b');
  await vi.waitFor(async () => expect(await (await fetch(url(1))).text()).toBe('1b'));
  // An edited load replaces its entry, which the pass that warms it deletes.
  await writeFile(
    join(root, 'src/main.js'),
    "import { CachedEchoLoader as Echo } from './loader.js';\nnew Echo().loadAsync(2);",
  );
  await vi.waitFor(async () => expect(await (await fetch(url(2))).text()).toBe('2b'));
  expect(await readdir(cache)).not.toContain(`${name(1)}.bin`);
});

test('the dev server serves an entry whose inputs are unchanged while it warms', async () => {
  const root = await project(
    "import { CachedHeldLoader as Held } from './held.js';\nnew Echo().loadAsync(1);\nnew Held().loadAsync();",
  );
  const released = join(root, 'node_modules/released');
  await writeFile(
    join(root, 'src/held.js'),
    `
    import { existsSync } from 'node:fs';
    export class CachedHeldLoader {
      async loadAsync() {
        while (!existsSync(${JSON.stringify(released)})) await new Promise((done) => setTimeout(done, 20));
      }
    }`,
  );
  const dependencies = { value: { value: 1 }, input: { path: 'input.txt' } };
  const entry = new CacheEntry({ version: 'echo@1', dependencies, root });
  await entry.load();
  await entry.save(new TextEncoder().encode('1a'));
  await writeFile(join(root, '.gitignore'), 'public/_vitecache/*\n');
  const server = await createServer({ root, server: { port: 0 } });
  servers.push(server);
  await server.listen();
  const url = `${server.resolvedUrls?.local[0]}_vitecache/${key({ version: 'echo@1', dependencies })}.bin`;
  expect(await (await fetch(url)).text()).toBe('1a');
  await writeFile(released, '');
});

test('a dev server whose global another plugin took over prunes nothing', async () => {
  const root = await project('new Echo().loadAsync(1);');
  await writeFile(join(root, '.gitignore'), 'public/_vitecache/*\n');
  const server = await createServer({ root, server: { port: 0 } });
  servers.push(server);
  await server.listen();
  const name = key({ version: 'echo@1', dependencies: { value: { value: 1 }, input: { path: 'input.txt' } } });
  const url = `${server.resolvedUrls?.local[0]}_vitecache/${name}.bin`;
  expect(await (await fetch(url)).text()).toBe('1a');
  const current = globalThis.vitecache;
  if (!current) throw new Error('the plugin set no global');
  vi.stubGlobal('vitecache', { ...current, loaded: new Set() });
  const stale = join(root, 'public/_vitecache', `${'0'.repeat(64)}.bin`);
  await writeFile(stale, 'stale');
  await writeFile(join(root, 'input.txt'), 'b');
  await vi.waitFor(async () => expect(await (await fetch(url)).text()).toBe('1b'));
  expect(await readFile(stale, 'utf8')).toBe('stale');
});

test('the dev server scans a public script added while it runs', async () => {
  const root = await project('');
  const server = await createServer({ root, server: { port: 0 } });
  servers.push(server);
  await server.listen();
  await mkdir(join(root, 'public/tree'), { recursive: true });
  await writeFile(join(root, 'public/tree/model.glts'), '');
  await writeFile(join(root, 'public/tree/index.glts'), script(locatedImport));
  const entry = `${server.resolvedUrls?.local[0]}_vitecache/${located('/tree/model.glts')}.bin`;
  await vi.waitFor(async () => expect(await (await fetch(entry)).text()).toBe('/tree/'));
});

test('a build refuses a publicDir that contains the root', async () => {
  const root = await project('');
  await expect(build({ root, publicDir: '..' })).rejects.toThrow(/publicDir that does not contain the root/);
});
