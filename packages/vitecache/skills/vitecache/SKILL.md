---
name: vitecache
description: Cache expensive computation with vitecache: wrap it in a cached loader that the Vite plugin finds and computes in Node during development and builds, so browsers and Node read the saved bytes instead of recomputing.
---

# vitecache

Use vitecache when recomputing a result costs more than reading its encoded bytes. The application owns encoding and decoding.

## Cached loaders

Put each computation in an exported class whose name matches `Cached…Loader`, with a `loadAsync` method, as a three.js `Loader` has; extending one works. The plugin constructs it without arguments, so let only `loadAsync`'s arguments select the result: constructor options, such as a `LoadingManager`, must not change the bytes it saves. `loadAsync` creates a `CacheEntry`, loads, computes on a miss, and saves with the same entry. Call `load()` on every call, without a memo in front of it: the plugin keeps entries that loads use, and an entry a memo answers for goes unused and is deleted. `save()` records the inputs as the preceding `load()` found them, so one that changes during the computation makes the next load miss instead of serving a stale result. Import the computation lazily inside the miss branch, so pages that hit never download its code.

A load in a public script, such as a `.glts` asset installed into `public/`, may pass URLs relative to the script. Before such a load the plugin calls the loader's `setPath` with the script's directory below `publicDir`, without Vite's base, so that keys do not depend on where the app is deployed: `/tree/` for `public/tree/index.glts`. Resolve relative URLs against that path before they select the result. To read a public file, pass the URL through `publicURL()` from `vitecache`: in Node a root-absolute path such as `/tree/model.glts` becomes the `file:` URL of that file below `publicDir`, and in the browser, which already loads public files by their URL, it is returned unchanged. Record that URL as a `{ path }` input on `save()`, not among the entry's dependencies, since it differs between Node and the browser and would change the key. Node's `fetch` refuses `file:` URLs, so read it there with a file-aware read, such as `readFile(new URL(url))`. The browser side must arrive at the same base-free path, or it misses and computes each time: there the `LoadingManager` running the script, such as the one glts gives a `.glts` script, resolves a relative URL to its served URL, from which strip the origin and the app's base, the entry's `basePath` without `_vitecache/`. A loader without `setPath` fails a public load, and loads in app sources get no `setPath`.

```ts
import { CacheEntry } from "vitecache"

export class CachedMeshLoader {
  async loadAsync(settings: { ratio: number }): Promise<Mesh> {
    const entry = new CacheEntry({
      version: "simplify@2",
      dependencies: {
        settings: { value: settings },
        algorithm: { path: "src/simplify.ts" },
        engine: { package: "meshoptimizer" },
      },
    })
    let bytes = await entry.load()
    if (bytes === undefined) {
      const { simplify } = await import("./simplify.ts")
      bytes = encodeMesh(await simplify(settings))
      await entry.save(bytes)
    }
    return decodeMesh(bytes)
  }
}
```

Declare every input that affects the result, under a stable name. A `{ value }` is JSON that selects which result the entry holds: changing it, a name, a path or a package name changes the key, while reordering object properties does not. File contents and package versions invalidate the entry without changing its key.

A `{ path }` is relative to the project root, never to the importing module, or a `file:` URL. A `{ package }` tracks only that package's installed version, so declare transitive packages separately when their versions matter. Bump `version` for changes the dependencies do not capture, such as a linked workspace package changed without a new version.

When inputs are only discovered while computing, such as the textures a model references, pass them to `save()` as its `dependencies`, like a compiler's depfile. They are checked on every load without being part of the key.

## Using loaders

Add the plugin:

```ts
import { defineConfig } from "vite"
import { vitecache } from "vitecache/vite"

export default defineConfig({ plugins: [vitecache()] })
```

A load is a `loadAsync` call with literal JSON arguments on `new CachedMeshLoader()`, or on a variable initialized with it, as in `new CachedMeshLoader().loadAsync({ ratio: 0.5 })` or `const meshes = new CachedMeshLoader()` and later `meshes.loadAsync({ ratio: 0.5 })`. Any other use fails the build, and in development is logged: passing a loader or such a variable around, exporting or reassigning it, calling another of its methods such as `setPath`, subclassing the loader, or loading with a variable. To serve several fixed variants, write one literal load per variant.

The plugin finds loads by scanning the project's JavaScript and TypeScript files, as Tailwind scans for class names, and matches the loader's imported name through aliases and namespace imports. It also scans the `.glts` scripts and every JavaScript and TypeScript module in `publicDir`, so assets installed there are warmed too. It skips `node_modules` and the build output, so a library's loaders are warmed only where the app uses them. It does not read `.vue` or `.svelte` files, and it warms a load in a file the app never imports, such as a test. Since variables are matched by name in the module, give a loader variable a name no other variable in that module uses.

The plugin repeats each load in Node by importing the loader's module through Vite's SSR loading. That module and its top-level imports must load without browser globals, and whatever the loader does after loading, such as decoding, runs in Node too. A build loads the Vite config file again to run the loaders, so configure plugins they rely on there rather than inline in a programmatic build.

In development the plugin warms every load at startup and again after every file change, and the page's cache requests wait for it, so the browser normally hits. It deletes entries no load uses: at startup, those left from earlier sessions, and later, an entry replaced by an edit once it has gone unused for `pruneAfter`, a minute by default, so that undoing the edit within that time reuses it. A build warms every load, then repeats them all and fails if that second pass saves anything, which means a key that changes between runs, such as one built from a timestamp. It then deletes every entry the build did not use, so the deployment holds exactly what the app requests.

Development and builds log each load that computes, by loader and source location, and announce a load still running after half a second; loads that hit are silent.

## Browsers and deployment

Browsers only read entries. A browser that misses, for a load the plugin could not see, computes the result itself each time, and `save()` warns once per version instead of writing. A deployed app serves entries without checking their inputs, so build again after changing them.

Entries keep their file names when their contents change, so browsers revalidate them before each use. Serve the cache directory with `ETag` or `Last-Modified`, as most static hosts do, and do not mark it immutable. When deploying below a URL prefix, pass that prefix with the cache path as `basePath`, such as `/app/_vitecache/`; the entry does not infer Vite's base.

The plugin adds the cache directory, `public/_vitecache/`, to `.gitignore`. A Node script outside Vite can use the same loaders. Its entries use `public/_vitecache/` below the working directory, or below `root` when passed.
