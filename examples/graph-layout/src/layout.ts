import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';

interface Graph {
  nodes: string[];
  edges: { from: string; to: string }[];
}

export async function layout(graph: Graph): Promise<Uint8Array> {
  const output = await new ELK().layout<ElkNode>({
    id: 'pipeline',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '32' },
    children: graph.nodes.map((id) => ({ id, width: 100, height: 44 })),
    edges: graph.edges.map(({ from, to }, index) => ({ id: String(index), sources: [from], targets: [to] })),
  });
  if (!output.children || !output.edges || output.width === undefined || output.height === undefined) {
    throw new Error('ELK returned an incomplete layout.');
  }
  const edges = output.edges.map((edge) => {
    if (!edge.sections) throw new Error('ELK returned an edge without a route.');
    return edge.sections.map((section) => {
      const points = [section.startPoint, ...section.bendPoints ?? [], section.endPoint];
      return `<polyline points="${points.map(({ x, y }) => `${x},${y}`).join(' ')}" marker-end="url(#arrow)" />`;
    }).join('');
  }).join('');
  const nodes = output.children.map(({ id, x, y, width, height }) => {
    if (x === undefined || y === undefined || width === undefined || height === undefined) throw new Error('ELK returned an unpositioned node.');
    const label = id.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    return `<g transform="translate(${x},${y})"><rect width="${width}" height="${height}" rx="4" /><text x="${width / 2}" y="${height / 2}" dominant-baseline="middle" text-anchor="middle">${label}</text></g>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${output.width} ${output.height}" role="img" aria-label="Build pipeline laid out by ELK">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7aa99a" /></marker></defs>
    <g fill="none" stroke="#7aa99a" stroke-width="1.5">${edges}</g>
    <g fill="#172c25" stroke="#a4dbc2">${nodes}</g>
  </svg>`;
  return new TextEncoder().encode(svg);
}
