import { CacheEntry } from '@drawcall/vitecache';

const graph = {
  nodes: ['Content', 'Images', 'Styles', 'Parse', 'Resize', 'Compile', 'HTML', 'Assets', 'CSS', 'Bundle', 'Website'],
  edges: [
    { from: 'Content', to: 'Parse' },
    { from: 'Images', to: 'Resize' },
    { from: 'Styles', to: 'Compile' },
    { from: 'Parse', to: 'HTML' },
    { from: 'Resize', to: 'Assets' },
    { from: 'Compile', to: 'CSS' },
    { from: 'HTML', to: 'Bundle' },
    { from: 'Assets', to: 'Bundle' },
    { from: 'CSS', to: 'Bundle' },
    { from: 'Bundle', to: 'Website' },
  ],
};

const entry = new CacheEntry({
  version: 'graph-layout@1',
  dependencies: {
    graph: { value: graph },
    algorithm: { path: 'src/layout.ts' },
    elk: { package: 'elkjs' },
  },
});

const start = performance.now();
let bytes = await entry.load();
const cached = bytes !== undefined;
if (bytes === undefined) {
  const { layout } = await import('./layout.ts');
  bytes = await layout(graph);
  await entry.save(bytes);
}
export const svg = new TextDecoder().decode(bytes);
export const message = cached
  ? `Loaded cached SVG in ${Math.round(performance.now() - start)} ms. ELK was not imported.`
  : `Computed layout in ${Math.round(performance.now() - start)} ms. ELK was lazy-loaded.`;
console.log(message);
