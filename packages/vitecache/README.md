# vitecache

Cache expensive computation as bytes: the Vite plugin computes it once in Node, then browsers and Node reuse it.

```sh
pnpm add vitecache
```

Wrap a computation in a class named `Cached…Loader` and load with literal arguments:

```ts
import { CacheEntry } from "vitecache"

export class CachedMeshLoader {
  async loadAsync(settings: { ratio: number }) {
    const entry = new CacheEntry({ version: "simplify@2", dependencies: { settings: { value: settings } } })
    let bytes = await entry.load()
    if (bytes === undefined) {
      bytes = await simplify(settings)
      await entry.save(bytes)
    }
    return bytes
  }
}

const mesh = await new CachedMeshLoader().loadAsync({ ratio: 0.5 })
```

Add the plugin:

```ts
import { defineConfig } from "vite"
import { vitecache } from "vitecache/vite"

export default defineConfig({ plugins: [vitecache()] })
```

The plugin finds these loads by scanning the project's source files, `.glts` scripts and other modules in `publicDir` included, computes them in Node during development and builds, and deletes entries no load uses. Browsers read the saved bytes.

For usage patterns, see the [vitecache skill](skills/vitecache/SKILL.md), also shipped in this package.
