import { expect, test } from 'vitest';
import { key } from '../src/entry.js';

test('keys are pinned, since a change to them orphans every saved entry', () => {
  const options = {
    version: 'unit@1',
    dependencies: { unit: { value: { x: [1, 2], level: 0 } }, generation: { value: '5b0c' } },
  };
  expect(key(options)).toBe('9ad9c5893f70b7d2b58dee2062ea146348878c76846cd4eb41acda8ad2854796');
  expect(
    key({
      ...options,
      dependencies: { generation: options.dependencies.generation, unit: { value: { level: 0, x: [1, 2] } } },
    }),
  ).toBe(key(options));
});

test('values that JSON cannot represent throw rather than collide', () => {
  expect(() => key({ version: 'nan@1', dependencies: { n: { value: NaN } } })).toThrow();
});

/** A function as the plugin tags it. */
const tagged = (fn: () => unknown, id: string, path: string) =>
  Object.defineProperty(fn, Symbol.for('vitecache.function'), { value: { id, inputs: [{ path }] } });

test('functions count as their identity, and untagged ones throw', () => {
  const options = (weld: () => unknown) => ({ version: 'fn@1', dependencies: { settings: { value: { weld } } } });
  // Browsers leave inputs empty, so they must not change the key.
  expect(key(options(tagged(() => 1, 'a', 'weld.ts')))).toBe(key(options(tagged(() => 2, 'a', 'fuse.ts'))));
  expect(key(options(tagged(() => 1, 'a', 'weld.ts')))).not.toBe(key(options(tagged(() => 1, 'b', 'weld.ts'))));
  expect(() => key(options(() => 1))).toThrow(/inline/);
});
