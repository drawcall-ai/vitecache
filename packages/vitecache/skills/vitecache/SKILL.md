---
name: vitecache
description: Cache expensive computation with vitecache: compute and save results in Node, read them in Node and browsers through a Vite development server or a deployed app, and prune entries no longer used.
---

# vitecache

Use vitecache when recomputing a result costs more than reading its encoded bytes. The application owns encoding and decoding. Declare every input that affects the computation as a named dependency. Use `{ value }` for JSON data and `{ package: "layout-engine" }` for an installed library. Package dependencies track the named package’s installed version, so declare transitive packages separately when their versions matter. Bump the computation version for changes beyond what the declared dependencies capture, such as a linked workspace package changed without a new version.

Give dependencies stable names. Use `{ path: "src/simplify.ts" }` for a project-root-relative path or `{ url: modelUrl }` when you have an asset URL served by the same project origin. Paths resolve from the Node `root` or the Vite project root, never from the importing module, page URL, or cache directory. The Vite plugin resolves served URLs to source paths; Node accepts local file URLs. Keep the plugin in the production build configuration when using served URLs so deployed entries can recover the same source paths. Production mappings cover public files and emitted assets with one backing source. Use `{ path }` when an imported asset is inlined or deduplicated from several source files.

Reordering JSON object properties or dependency declarations does not change identity; array order matters. Changing a dependency name, JSON value, resolved path, or package name does. File contents and installed package versions invalidate the existing result in Node and through the Vite plugin; installation paths do not affect identity.

Load, compute on a miss, then save with the same entry: `save()` requires a preceding `load()`, because it records the file contents and package versions as that load found them. A dependency that changes during the computation therefore makes the next load miss rather than serve a stale result. Use a separate entry for each concurrent computation.

Only Node writes entries. Run the same code in browsers: there `load()` reads the deployed or dev-served cache, and `save()` writes nothing and warns once per version, so a browser that misses computes the result for itself each time. Fill the cache by running the computations in Node, for example in a precompute script that the build runs first.

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
  bytes = encodeMesh(await simplify())
  await entry.save(bytes)
}

const mesh = decodeMesh(bytes)
```

Constructor dependencies select which result an entry holds. When some inputs are only discovered while computing, such as the files a script imported or the textures a model referenced, pass them to `save(bytes, { dependencies })` instead, like a compiler's depfile. Their names stay out of the key, so generated names such as `file:${i}` are fine.

```ts
const entry = new CacheEntry({ version: "bake@1", dependencies: { scene: { url: sceneUrl } } })
let bytes = await entry.load()
if (bytes === undefined) {
  const { result, files } = await bake(sceneUrl) // files: URLs the bake read
  bytes = encode(result)
  await entry.save(bytes, { dependencies: Object.fromEntries(files.map((url, i) => [`file:${i}`, { url }])) })
}
```

Add the Vite plugin when browsers load entries. During development it serves the cache directory and checks every file and package an entry was built from before serving it, and it resolves served URLs to the project paths Node uses, so both derive the same keys:

```ts
import { defineConfig } from "vite"
import { vitecache } from "vitecache/vite"

export default defineConfig({ plugins: [vitecache()] })
```

Generate caches in Node before building, and include the generated public files in the build or deployment even when Git ignores them. A deployed app serves entries without checking their dependencies, so regenerate affected caches before deployment. The plugin answers a missing entry without an HTTP error, but a static host answers it with 404, which the browser console shows; each one marks a result the deployment lacks, so precompute what deployed users will request.

Browsers keep loaded entries in their HTTP cache and revalidate them before each use, because an entry's file name stays the same when its contents change. In deployments, serve the cache directory with `ETag` or `Last-Modified`, as most static hosts do, so unchanged entries cost a `304` instead of a download. Do not mark cache files immutable.

The cache directory keeps every entry ever saved, and the build deploys all of them. Loads and saves in Node, and loads through the development server, mark an entry as used; `prune` deletes entries not used since a time. Run it after a pass that loads everything the deployment needs, such as a precompute script:

```ts
import { prune } from "vitecache/prune"

const start = new Date()
await precompute() // loads or saves every entry the app uses
await prune({ before: start })
```

When no single pass loads everything, prune with an older cutoff, such as a week ago.

For custom locations, coordinate the filesystem destination with the URL used by browser callers. A filesystem path and a browser URL are different values. When deploying below a URL prefix, include that prefix in the browser cache path; the client does not infer Vite's base URL. Node jobs should select the same project root as the Vite app when launched from a different working directory.
