# vitecache

Cache expensive computation as bytes: compute it once in Node, then reuse it in Node runs and browsers.

The package, its usage and its skill live in [packages/vitecache](packages/vitecache/README.md).

Run `pnpm dev` for the [graph-layout example](examples/graph-layout): [`src/compute.ts`](examples/graph-layout/src/compute.ts) imports the ELK layout engine only on a cache miss. Cache hits display the stored SVG without loading the computation code. Node computes and saves the cache (`pnpm precompute`), which `pnpm dev` and the example build run first; the browser only reads it.
