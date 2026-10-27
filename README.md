# vitecache

Cache expensive computation as bytes, then reuse it across browser sessions and Node runs.

```sh
pnpm add vitecache
```

```ts
import { CacheEntry } from "vitecache"
import modelUrl from "./models/chair.glb?url"

const entry = new CacheEntry({
  version: "simplify@2",
  dependencies: {
    settings: { value: { ratio: 0.5, preserveUVs: true } },
    algorithm: { path: "src/simplify.ts" },
    model: { url: modelUrl },
  },
})

let bytes = await entry.load()

if (bytes === undefined) {
  bytes = await simplify()
  await entry.save(bytes)
}

useMeshBytes(bytes)
```

Entries identify computations by version and named dependencies: JSON `{ value }`, file `{ path }` or `{ url }`, and installed library `{ package: "elkjs" }`. Node and the Vite development plugin validate file contents and package versions without changing entry keys.

Paths are always relative to the project root: `root` in Node (the working directory by default), or the Vite project root in browsers. The Vite plugin resolves served URLs to their source paths and preserves mappings for public files and emitted assets in production builds; Node accepts local file URLs.

Package installation paths are excluded from identity; transitive packages need their own declarations. Load before computing so saving can detect dependencies that changed during computation.

Node reads and writes `<project_root>/public/_vitecache/`. Add the plugin to save browser results into the same directory during development:

```ts
import { defineConfig } from "vite"
import { vitecache } from "vitecache/vite"

export default defineConfig({ plugins: [vitecache()] })
```

Node saves and the plugin add the cache directory to `.gitignore`. Generate caches before building and include them in your deployment. Browsers without the plugin read public cache files, assume dependencies unchanged, and warn and skip writes when `save()` is called.

For usage patterns, see the [vitecache skill](packages/vitecache/skills/vitecache/SKILL.md), also shipped in the npm package.

Run `pnpm dev` for the [graph-layout example](examples/graph-layout): [`src/compute.ts`](examples/graph-layout/src/compute.ts) imports the ELK layout engine only on a cache miss. Cache hits display the stored SVG without loading the computation code. `pnpm precompute` generates the cache from Node; the example build runs precomputation automatically.
