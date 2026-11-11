# vitecache

Cache expensive computation as bytes: compute it once in Node, then reuse it in Node runs and browsers.

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

The same code runs in both places. Node reads and writes `<project_root>/public/_vitecache/`; browsers only read it, and a result they compute is used but not saved. Add the plugin so that the browser shares Node's keys and checks during development:

```ts
import { defineConfig } from "vite"
import { vitecache } from "vitecache/vite"

export default defineConfig({ plugins: [vitecache()] })
```

Node saves and the plugin add the cache directory to `.gitignore`. Generate caches in Node before building and include them in your deployment; `prune` from `vitecache/prune` removes entries no load or save has used since a given time.

For usage patterns, see the [vitecache skill](skills/vitecache/SKILL.md), also shipped in this package.
