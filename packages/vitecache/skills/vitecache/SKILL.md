---
name: vitecache
description: Cache expensive computation with vitecache in browsers or Node, connect browser saves to a Vite development server, and reuse cached bytes in deployed apps.
---

# vitecache

Use vitecache when recomputing a result costs more than reading its encoded bytes. The application owns encoding and decoding. Declare every input that affects the computation as a named dependency. Use `{ value }` for JSON data and `{ package: "elkjs" }` for an installed library. Package dependencies track the named package’s installed version, so declare transitive packages separately when their versions matter. Bump the computation version for changes beyond what the declared dependencies capture.

Give dependencies stable names. Use `{ path: "src/simplify.ts" }` for a project-root-relative path or `{ url: modelUrl }` when you have an asset URL served by the same project origin. Paths resolve from the Node `root` or the Vite project root, never from the importing module, page URL, or cache directory. The Vite plugin resolves served URLs to source paths; Node accepts local file URLs. Keep the plugin in the production build configuration when using served URLs so deployed entries can recover the same source paths. Production mappings cover public files and emitted assets with one backing source. Use `{ path }` when an imported asset is inlined or deduplicated from several source files.

Reordering JSON object properties or dependency declarations does not change identity; array order matters. Changing a dependency name, JSON value, resolved path, or package name does. File contents and installed package versions invalidate the existing result when filesystem validation is available; installation paths do not affect identity.

Load once and compute on a miss. Reuse that entry when saving: loading captures file contents and package versions before computation, allowing saving to reject a result if those dependencies changed in the meantime. A new entry or a save without a preceding load cannot establish that relationship. Entries containing only value dependencies can save directly. If saving fails because dependencies changed, load again and recompute before retrying. A dependency without a backing file, such as a server route, a virtual module or a package the app does not install, makes `save()` throw `MissingDependencyError`; catch it to carry on with the uncached result. Use a separate entry for each concurrent computation.

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

Constructor dependencies select which result an entry holds. When some inputs are only discovered while computing, such as the files a script imported or the textures a model referenced, pass them to `save(bytes, { dependencies })` instead, like a compiler's depfile: paths, URLs and packages only, since anything that selects the result belongs in the constructor. Every later `load()` rechecks them and misses when one changed or disappeared, and the next save replaces the same entry. They are hashed when `save()` runs rather than when the computation read them, so an edit made during a long computation goes unnoticed until the file changes again.

```ts
const entry = new CacheEntry({ version: "bake@1", dependencies: { scene: { url: sceneUrl } } })
let bytes = await entry.load()
if (bytes === undefined) {
  const { result, files } = await bake(sceneUrl) // files: URLs the bake read
  bytes = encode(result)
  await entry.save(bytes, { dependencies: Object.fromEntries(files.map((url, i) => [`file:${i}`, { url }])) })
}
```

Use the Vite plugin when browser computation should produce reusable project files:

```ts
import { defineConfig } from "vite"
import { vitecache } from "vitecache/vite"

export default defineConfig({ plugins: [vitecache()] })
```

Generate caches during development or from Node before building when deployed users should download precomputed results. Include the generated public files in the build or deployment even when Git ignores them. The plugin writes files during development; it does not supply a production write server. Browsers without the plugin assume files and package versions unchanged, saved dependencies included, so regenerate affected caches before deployment. Calling `save()` there warns and skips persistence. The plugin answers a missing entry without an HTTP error, but a static host answers it with 404, which the browser console shows; each one marks a result the deployment lacks, so precompute what deployed users will request.

For custom locations, coordinate the filesystem destination with the URL used by browser callers. A filesystem path and a browser URL are different values. When deploying below a URL prefix, include that prefix in the browser cache path; the client does not infer Vite's base URL. Node jobs should select the same project root as the Vite app when launched from a different working directory.
