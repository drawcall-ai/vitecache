import { CachedGraphLayoutLoader } from './loader.ts';

const diagram = document.querySelector('figure');
const status = document.querySelector('output');
if (!diagram || !status) throw new Error('Missing example elements.');

const start = performance.now();
diagram.innerHTML = await new CachedGraphLayoutLoader().loadAsync({
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
});
status.textContent = `Laid out in ${Math.round(performance.now() - start)} ms.`;
