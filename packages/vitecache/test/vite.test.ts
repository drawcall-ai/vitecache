import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { build, createLogger, createServer, type ViteDevServer } from 'vite';
import { key } from '../src/entry.js';

const servers: ViteDevServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A project whose page runs `main`, with a cached loader that saves its arguments and the contents of input.txt, and
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
        await entry.save(new TextEncoder().encode(JSON.stringify(value) + input));
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
        // Saving fails unless publicURL found the file below the plugin's publicDir.
        await entry.save(new TextEncoder().encode(this.path), { dependencies: [{ path: publicURL(resolved) }] });
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
  const errors: string[] = [];
  const customLogger = { ...createLogger('silent'), error: (message: string) => void errors.push(message) };
  await expect(build({ root, customLogger })).rejects.toThrow(/warming failed/);
  expect(errors.join('\n').replace(/\x1b\[\d+m/g, '')).toMatch(/public\/tree\/index\.glts:3:7\n.*no setPath/);
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
