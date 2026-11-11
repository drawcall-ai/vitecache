import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { build, createServer, type ViteDevServer } from 'vite';
import { key } from '../src/entry.js';

const servers: ViteDevServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A project whose page runs `main`, with a cached loader that saves its arguments and the contents of input.txt, and
 * logs each run outside the watched files.
 */
async function project(main: string, version = "'echo@1'", options = ''): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vitecache-vite-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(
    join(root, 'vite.config.js'),
    `
    import { vitecache } from ${JSON.stringify(resolve('src/vite.ts'))};
    export default { logLevel: 'silent', plugins: [vitecache(${options})] };`,
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
        const entry = new CacheEntry({ version: ${version}, dependencies });
        if (await entry.load()) return;
        const input = await readFile(new URL('../input.txt', import.meta.url), 'utf8');
        await entry.save(new TextEncoder().encode(JSON.stringify(value) + input));
      }
    }`,
  );
  await writeFile(join(root, 'src/main.js'), `import { CachedEchoLoader as Echo } from './loader.js';\n${main}`);
  return root;
}

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
  // Public files are served as they are, so their loads are not the app's.
  await writeFile(join(root, 'public/served.js'), "import { CachedEchoLoader as E } from '../src/loader.js'; [E];");
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
});

test('a build fails when a second warming saves again', async () => {
  const root = await project('new Echo().loadAsync(1);', 'String(Math.random())');
  await expect(build({ root })).rejects.toThrow(/keys are not stable/);
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

test('the dev server warms every load at startup, holds requests for it, warms after changes, and prunes', async () => {
  const root = await project('new Echo().loadAsync(1);', "'echo@1'", '{ pruneAfter: 300 }');
  const cache = join(root, 'public/_vitecache');
  const stale = `${'0'.repeat(64)}.bin`;
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, stale), 'stale');
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
  await vi.waitFor(async () => expect(await readdir(cache)).not.toContain(stale));
  // The save's own files do not warm again.
  await new Promise((done) => setTimeout(done, 500));
  expect(await runs(root)).toBe(1);
  await writeFile(join(root, 'input.txt'), 'b');
  await vi.waitFor(async () => expect(await (await fetch(url(1))).text()).toBe('1b'));
  // An edited load replaces its entry, which stays for pruneAfter.
  await writeFile(
    join(root, 'src/main.js'),
    "import { CachedEchoLoader as Echo } from './loader.js';\nnew Echo().loadAsync(2);",
  );
  await vi.waitFor(async () => expect(await (await fetch(url(2))).text()).toBe('2b'));
  expect(await readdir(cache)).toContain(`${name(1)}.bin`);
  await vi.waitFor(async () => expect(await readdir(cache)).not.toContain(`${name(1)}.bin`), { timeout: 2000 });
});
