import { expect, test } from 'vitest';
import { CacheEntry } from '../src/node.js';
import { key } from '../src/key.js';
import { resolvedDependencies } from '../src/dependencies.js';

test('keys canonicalize named dependencies and JSON values while preserving dependency kinds', () => {
  const first = key('mesh@1', { options: { value: { b: [2, 1], a: { x: true, y: null } } }, model: { path: 'missing.glb' }, algorithm: { path: 'src/a.ts' }, engine: { package: 'elkjs' } });
  const second = key('mesh@1', { engine: { package: 'elkjs' }, algorithm: { path: 'src/a.ts' }, model: { path: 'missing.glb' }, options: { value: { a: { y: null, x: true }, b: [2, 1] } } });
  expect(first).toBe(second);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(resolvedDependencies({ source: { path: './src/a.ts' } })).toEqual({ source: { path: 'src/a.ts' } });
  const variants = [
    key('mesh@1', { ratio: { value: 0.5 }, model: { path: 'model.glb' } }),
    key('mesh@2', { ratio: { value: 0.5 }, model: { path: 'model.glb' } }),
    key('mesh@1', { ratio: { value: 0.7 }, model: { path: 'model.glb' } }),
    key('mesh@1', { ratio: { value: 0.5 }, renamed: { path: 'model.glb' } }),
    key('mesh@1', { ratio: { value: 0.5 }, model: { path: 'other.glb' } }),
  ];
  expect(new Set(variants).size).toBe(5);
  expect(key('array', { data: { value: [1, 2] } })).not.toBe(key('array', { data: { value: [2, 1] } }));
  expect(key('kind', { data: { value: 'model.glb' } })).not.toBe(key('kind', { data: { path: 'model.glb' } }));
  expect(key('package', { engine: { package: 'elkjs' } })).not.toBe(key('package', { engine: { package: 'other' } }));
});

test('rejects unsupported JSON instead of silently changing its identity', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const iterated = [1];
  Object.defineProperty(iterated, Symbol.iterator, { value: function* () { yield 2; } });
  const indexedGetter = Object.defineProperty([1], '0', { get() { return 2; } });
  const values: unknown[] = [NaN, Infinity, undefined, new Date(), 1n, cycle, iterated, indexedGetter, { nested: undefined }, [, 1], { get value() { return 1; } }];
  for (const value of values) {
    expect(() => Reflect.construct(CacheEntry, [{ version: 'invalid', dependencies: { data: { value } } }])).toThrow(TypeError);
  }
  expect(() => new CacheEntry({ version: '' })).toThrow(TypeError);
});

test('dependency paths are project-root-relative and package names cannot be paths or subpaths', () => {
  for (const path of ['/absolute/model.glb', 'C:/models/chair.glb', 'C:\\models\\chair.glb', '\\\\server\\share', 'https://example.test/model.glb', 'file:///tmp/model.glb']) {
    expect(() => new CacheEntry({ version: 'paths@1', dependencies: { model: { path } } })).toThrow(/relative to the project root/);
  }
  expect(() => new CacheEntry({ version: 'paths@1', dependencies: { model: { path: './public/models/chair.glb' } } })).not.toThrow();
  for (const name of ['../secret', '/secret', 'elkjs/lib/elk-api', '@scope/package/subpath', '@scope/../secret']) {
    expect(() => new CacheEntry({ version: 'package@1', dependencies: { engine: { package: name } } })).toThrow(TypeError);
  }
});

test('descriptors require exactly one source', () => {
  for (const source of ['src/model.glb', {}, { path: 'src/model.glb', url: '/model.glb' }, { value: 1, package: 'elkjs' }, { path: 'src/model.glb', extra: true }, { url: '' }]) {
    expect(() => Reflect.construct(CacheEntry, [{ version: 'invalid', dependencies: { data: source } }])).toThrow(TypeError);
  }
});
