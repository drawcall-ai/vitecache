import { expect, test } from 'vitest';
import { discover } from '../src/discover.js';

const load = (before: string, args: string) =>
  discover(
    `import type { Mesh } from './mesh';\nimport { CachedMeshLoader } from './loader';\n${before}\nnew CachedMeshLoader().loadAsync(${args});`,
    'main.ts',
  );

test('inline functions may use globals, their own variables and types, and record what they import', () => {
  const weld = "async (mesh: Mesh) => { const { weld } = await import('./weld.ts'); return weld(mesh, Math.PI); }";
  const [found] = load('', `{ ratio: -0.5, weld: ${weld} }`);
  expect(found?.functions.map((inline) => inline.imports)).toEqual([['./weld.ts']]);
});

test.each([
  ['a module variable', 'const ratio = 1;', '() => ratio', /must not use ratio/],
  ['an import', '', '() => CachedMeshLoader', /must not use CachedMeshLoader/],
  ['a method', '', '{ weld() {} }', /literal JSON or inline functions/],
])('loads fail on %s', (_, before, args, error) => {
  expect(() => load(before, args)).toThrow(error);
});
