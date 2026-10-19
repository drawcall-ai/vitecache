# vitecache

Cache expensive computation as bytes, then reuse it across browser sessions and Node runs.

```sh
pnpm add @drawcall/vitecache
```

```ts
import { CacheEntry } from "@drawcall/vitecache"
import modelUrl from "./models/chair.glb?url"

const entry = new CacheEntry({
  version: "simplify@2",
  inputs: { ratio: 0.5, preserveUVs: true },
  fileDependencies: {
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

Entries identify computations by version, JSON inputs, and named dependency paths. Declare each dependency as `{ path }` or `{ url }`. Paths are always relative to the project root: `root` in Node (the working directory by default), or the Vite project root in browsers. The Vite plugin resolves served URLs to their source paths and preserves mappings for public files and emitted assets in production builds; Node accepts local file URLs. Node and the Vite development plugin invalidate results when dependency contents change. Load before computing so saving can detect files that changed during computation.

Node reads and writes `<project_root>/public/_vitecache/`. Add the plugin to save browser results into the same directory during development:

```ts
import { defineConfig } from "vite"
import { vitecache } from "@drawcall/vitecache/vite"

export default defineConfig({ plugins: [vitecache()] })
```

Node saves and the plugin add the cache directory to `.gitignore`. Generate caches before building and include them in your deployment. Browsers without the plugin read public cache files, assume dependencies unchanged, and warn and skip writes when `save()` is called.

For usage patterns, see the [vitecache skill](skills/vitecache/SKILL.md), also shipped in this package.
