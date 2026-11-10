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

Entries identify computations by version and named dependencies: JSON `{ value }`, file `{ path }` or `{ url }`, and installed library `{ package: "layout-engine" }`. Node and the Vite development plugin validate file contents and package versions without changing entry keys.

Node reads and writes `<project_root>/public/_vitecache/`. Add the plugin to save browser results into the same directory during development:

```ts
import { defineConfig } from "vite"
import { vitecache } from "vitecache/vite"

export default defineConfig({ plugins: [vitecache()] })
```

Node saves and the plugin add the cache directory to `.gitignore`. Generate caches before building and include them in your deployment; `prune` from `vitecache/prune` removes entries no load or save has used since a given time. Browsers without the plugin read public cache files, assume dependencies unchanged, and warn and skip writes when `save()` is called.

For usage patterns, see the [vitecache skill](skills/vitecache/SKILL.md), also shipped in this package.
