import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { build } from 'vite';

const execute = promisify(execFile);

test('selects Node exports and bundles the browser entry without filesystem code', async () => {
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
    "import * as api from 'vitecache'; console.log(import.meta.resolve('vitecache')); console.log(Object.keys(api).join(','));",
  ]);
  const [path, exports] = stdout.trim().split('\n');
  expect(path).toMatch(/\/dist\/node\.js$/);
  expect(exports).toBe('CacheEntry');
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'cache-consumer',
      resolveId(id) {
        if (id === resolve('consumer')) return '\0consumer';
      },
      load(id) {
        if (id === '\0consumer') return "export { CacheEntry } from 'vitecache';";
      },
    }],
    build: { write: false, minify: false, lib: { entry: 'consumer', formats: ['es'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!output || 'close' in output) throw new Error('Expected browser bundle output');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing browser chunk');
  expect(chunk.code).toContain('CacheEntry');
  expect(chunk.code).not.toContain('indexedDB');
  expect(chunk.code).not.toContain('node:fs');
  expect(chunk.code).not.toContain('process.cwd');
});
