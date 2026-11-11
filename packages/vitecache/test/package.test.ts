import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { build } from 'vite';

test('in the built package, Node imports the Node entry, and browser bundles contain no Node code', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    "import * as api from 'vitecache'; console.log(import.meta.resolve('vitecache'), Object.keys(api).join());",
  ]);
  expect(stdout.trim()).toMatch(/\/dist\/node\.js CacheEntry,publicURL$/);
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'consumer',
        resolveId: (id) => (id === resolve('consumer') ? '\0consumer' : undefined),
        load: (id) => (id === '\0consumer' ? "export { CacheEntry, publicURL } from 'vitecache';" : undefined),
      },
    ],
    build: { write: false, minify: false, lib: { entry: 'consumer', formats: ['es'] } },
  });
  const code = JSON.stringify(output);
  expect(code).toContain('CacheEntry');
  expect(code).not.toMatch(/node:|process\.cwd/);
});
