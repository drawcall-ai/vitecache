# vitecache

Cache expensive computation as bytes, then reuse it across browser sessions and Node runs.

The package, its usage and its skill live in [packages/vitecache](packages/vitecache/README.md).

Run `pnpm dev` for the [graph-layout example](examples/graph-layout): [`src/compute.ts`](examples/graph-layout/src/compute.ts) imports the ELK layout engine only on a cache miss. Cache hits display the stored SVG without loading the computation code. `pnpm precompute` generates the cache from Node; the example build runs precomputation automatically.
