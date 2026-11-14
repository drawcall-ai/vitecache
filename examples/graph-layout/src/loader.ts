import { CacheEntry } from 'vitecache';

type Graph = { nodes: string[]; edges: { from: string; to: string }[] };

/** Lays graphs out as SVG. The vitecache plugin warms each load, so the page imports ELK only on a miss. */
export class CachedGraphLayoutLoader {
  async loadAsync(graph: Graph): Promise<string> {
    const entry = new CacheEntry({
      version: 'graph-layout@1',
      dependencies: { graph: { value: graph } },
    });
    let bytes = await entry.load();
    if (bytes === undefined) {
      const { layout } = await import('./layout.ts');
      bytes = await layout(graph);
      await entry.save(bytes);
    }
    return new TextDecoder().decode(bytes);
  }
}
