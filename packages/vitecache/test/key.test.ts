import { expect, test } from 'vitest';
import { CacheEntry } from '../src/node.js';
import { identity, key } from '../src/key.js';

test('keys canonicalize inputs and resolved dependency names and paths', () => {
  const first = key(identity({ version: 'mesh@1', inputs: { b: [2, 1], a: { x: true, y: null } } }), { model: 'missing.glb', algorithm: './src/a.ts' });
  const second = key(identity({ version: 'mesh@1', inputs: { a: { y: null, x: true }, b: [2, 1] } }), { algorithm: 'src/a.ts', model: 'missing.glb' });
  expect(first).toBe(second);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  const original = identity({ version: 'mesh@1', inputs: { ratio: 0.5 } });
  const variants = [
    key(original, { model: 'model.glb' }),
    key(identity({ version: 'mesh@2', inputs: { ratio: 0.5 } }), { model: 'model.glb' }),
    key(identity({ version: 'mesh@1', inputs: { ratio: 0.7 } }), { model: 'model.glb' }),
    key(original, { renamed: 'model.glb' }),
    key(original, { model: 'other.glb' }),
  ];
  expect(new Set(variants).size).toBe(5);
  expect(key(identity({ version: 'array', inputs: [1, 2] }), {})).not.toBe(key(identity({ version: 'array', inputs: [2, 1] }), {}));
});

test('rejects unsupported JSON rather than silently changing its identity', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const iterated = [1];
  Object.defineProperty(iterated, Symbol.iterator, { value: function* () { yield 2; } });
  const indexedGetter = Object.defineProperty([1], '0', { get() { return 2; } });
  const values: unknown[] = [NaN, Infinity, undefined, new Date(), 1n, cycle, iterated, indexedGetter, { nested: undefined }, [, 1], { get value() { return 1; } }];
  for (const value of values) {
    // Reflect exercises invalid JavaScript callers without weakening the public JSON type.
    expect(() => Reflect.construct(CacheEntry, [{ version: 'invalid', inputs: { value } }])).toThrow(TypeError);
  }
  expect(() => new CacheEntry({ version: '' })).toThrow(TypeError);
});


test('dependency paths must be project-root-relative in every runtime', () => {
  for (const path of ['/absolute/model.glb', 'C:/models/chair.glb', 'C:\\models\\chair.glb', '\\\\server\\share', 'https://example.test/model.glb', 'file:///tmp/model.glb']) {
    expect(() => new CacheEntry({ version: 'paths@1', fileDependencies: { model: { path } } })).toThrow(/relative to the project root/);
  }
  expect(() => new CacheEntry({ version: 'paths@1', fileDependencies: { model: { path: './public/models/chair.glb' } } })).not.toThrow();
});


test('dependency locators require exactly one path or url and never accept legacy strings', () => {
  for (const locator of ['src/model.glb', {}, { path: 'src/model.glb', url: '/model.glb' }, { path: 'src/model.glb', extra: true }, { url: '' }]) {
    expect(() => Reflect.construct(CacheEntry, [{ version: 'invalid', fileDependencies: { model: locator } }])).toThrow(TypeError);
  }
});
