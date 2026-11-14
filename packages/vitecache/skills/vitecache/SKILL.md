---
name: vitecache
description: Cache expensive computation with vitecache: wrap it in a cached loader that the Vite plugin finds and computes in Node during development and builds, so browsers and Node read the saved bytes instead of recomputing.
---

# vitecache

Use vitecache when recomputing a result costs more than reading its encoded bytes. The application owns encoding and decoding.

## Cached loaders

Put each computation in an exported class whose name matches `Cached…Loader`, with a `loadAsync` method, as a three.js `Loader` has; extending one works. The plugin constructs it without arguments, so let only `loadAsync`'s arguments select the result: constructor options, such as a `LoadingManager`, must not change the bytes it saves. `loadAsync` creates a `CacheEntry`, loads, computes on a miss, and saves with the same entry. Call `load()` on every call, without a memo in front of it: the plugin keeps entries that loads use, and an entry a memo answers for goes unused and is deleted. `save()` checks each input against its state when the computation got it, a declared one as the preceding `load()` found it, and throws and deletes the entry when one changed, since the result may come from the old content; the next load computes again. Import the computation lazily inside the miss branch, so pages that hit never download its code.

```ts
import { CacheEntry } from "vitecache"

export class CachedMeshLoader {
  async loadAsync(settings: { ratio: number }): Promise<Mesh> {
    const entry = new CacheEntry({
      version: "simplify@2",
      dependencies: { settings: { value: settings } },
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

Declare what selects the result as a `{ value }` under a stable name: JSON whose change, or a change of its name, changes the key, while reordering object properties does not. Nothing checks that a key is the same in every run, so one built from a timestamp, for example, makes browsers miss.

Declare the inputs a result is built from, which invalidate the entry when they change, as a `{ path }` relative to the project root, never to the importing module, or a `{ package }`. Among the entry's dependencies, an input is part of the key. Passed to `save()` as its `dependencies`, which may also hold `file:` URLs, it is not, so pass there what the computation turns out to read; it is recorded as it is then, so a change during the computation goes unseen. Both are checked on every load.

While the plugin warms a load, it adds what the load used to these inputs, each as it was when the load got it: the files of the loader's module and of every module it ran, such as the computation it imports lazily, and the public files `publicURL()` gave it. A computation that changes one of them, such as a file it reads with `publicURL()` and then rewrites, fails every warming, and in development warms again after each failure. Declare only what these miss, such as a file read with `fs`. A module in `node_modules` counts as the `package.json` of the package it belongs to, which covers what it imports, and a linked workspace package counts by its files. Bump `version` for changes no input captures, such as a package patched in place.

A load in a public script, such as a `.glts` asset installed into `public/`, may pass URLs relative to the script. Before it, the plugin calls the loader's `setPath` with the script's URL directory without Vite's base, such as `/tree/` for `public/tree/index.glts`, and fails the load if the loader has none. In the browser nothing calls `setPath`, and the script's `LoadingManager`, such as the one glts provides, resolves URLs to their served URLs instead. Key on the path below the app's base, which both give, and fetch `publicURL()` of the resolved URL:

```ts
import { Loader } from "three"
import { CacheEntry, publicURL } from "vitecache"

const basePath = "/_vitecache/" // the cache's URL, with the app's base

export class CachedModelLoader extends Loader {
  async loadAsync(url: string): Promise<Model> {
    const served = this.manager.resolveURL(this.path + url)
    // In Node, the path setPath gave has no base; a served URL has the app's.
    const base = served.startsWith("/") ? "/" : new URL("..", new URL(basePath, served)).pathname
    const path = `/${new URL(served, "http://node").pathname.slice(base.length)}`
    const entry = new CacheEntry({ version: "model@1", basePath, dependencies: { path: { value: path } } })
    let bytes = await entry.load()
    if (bytes === undefined) {
      const response = await fetch(publicURL(served))
      bytes = encodeModel(await buildModel(await response.arrayBuffer()))
      await entry.save(bytes)
    }
    return decodeModel(bytes)
  }
}
```

`publicURL()` returns other URLs unchanged, and in browsers every URL. In Node it maps a root-absolute path to a `data:` URL of that file below `publicDir`, since Node's `fetch` reads no `file:` URLs. A three.js loader fetches public files in Node too when its `LoadingManager` modifies URLs with it, as in `manager.setURLModifier(publicURL)`, and the files it fetches become inputs of the load, even when code an inline function imports does the loading. Only a fetch the load itself starts is recorded, so do not share one across loads, such as a promise kept in a module. Its `FileLoader` needs a `ProgressEvent` global, which Node lacks, and loading images still needs a DOM.

## Using loaders

Add the plugin:

```ts
import { defineConfig } from "vite"
import { vitecache } from "vitecache/vite"

export default defineConfig({ plugins: [vitecache()] })
```

A load is a `loadAsync` call with literal JSON arguments on `new CachedMeshLoader()`, or on a variable initialized with it, as in `new CachedMeshLoader().loadAsync({ ratio: 0.5 })` or `const meshes = new CachedMeshLoader()` and later `meshes.loadAsync({ ratio: 0.5 })`. Any other use fails the build, and in development is logged: passing a loader or such a variable around, exporting or reassigning it, calling another of its methods such as `setPath`, which the plugin calls itself for loads in public scripts, subclassing the loader, or loading with a variable. To serve several fixed variants, write one literal load per variant.

Arguments can also hold inline functions, as arrow or `function` expressions written in the load, which let the caller customize the computation:

```ts
await new CachedMeshLoader().loadAsync({
  ratio: 0.5,
  weld: async (mesh: Mesh) => {
    const { weld } = await import("./weld.ts")
    return weld(mesh, 0.01)
  },
})
```

Warming runs a copy of the function's source in Node, where its relative imports resolve as in the load's module. So it may use globals, what it declares and what it imports dynamically, but no name its module declares anywhere else, imports included. Write it as a property, `weld: (mesh) => …`, not as a method. The loader declares it in a `{ value }`, as it does JSON.

The key counts a function by its source and its module's path, and the modules it runs are inputs, as the loader's are. List `vitecache()` before plugins that transform source, since it reads functions as the file holds them. A function the plugin did not find inline in a load, such as one built at runtime, makes the key throw. Public scripts cannot pass inline functions, since browsers run them untransformed.

The plugin finds loads by scanning the project's JavaScript and TypeScript files, as Tailwind scans for class names, and matches the loader's imported name through aliases and namespace imports. It also scans the `.glts` scripts and every JavaScript and TypeScript module in `publicDir`, so assets installed there are warmed too. It skips `node_modules` and the build output, so a library's loaders are warmed only where the app uses them. The plugin does not read `.vue` or `.svelte` files, and it warms a load in a file the app never imports, such as a test. Since variables are matched by name in the module, give a loader variable a name no other variable in that module uses. A library that ships cached loaders peer-depends on `vitecache`, so they and the plugin use the same vitecache.

The plugin repeats each load in Node by importing the loader's module with a module runner on Vite's SSR environment. That module and its top-level imports must load without browser globals, and whatever the loader does after loading, such as decoding, runs in Node too. A build loads the Vite config file again to run the loaders, so configure plugins they rely on there rather than inline in a programmatic build.

In development the plugin warms every load at startup and again after every file change, and a cache request waits for it unless the entry's inputs are unchanged, so the browser normally hits. After each warming without a failed load, it deletes the entries that warming did not load, so undoing an edit computes its result again. A build warms every load once and deletes the same way, so the deployment holds exactly what the app requests. Several Vite projects warming in one Node process are not supported.

Development and builds announce a load still running after half a second, by loader and source location.

## Browsers and deployment

Browsers only read entries. A browser that misses, for a load the plugin could not see, computes the result itself each time, and `save()` warns once per version instead of writing. A deployed app serves entries without checking their inputs, so build again after changing them.

Entries keep their file names when their contents change, so browsers revalidate them before each use. Serve the cache directory with `ETag` or `Last-Modified`, as most static hosts do, and do not mark it immutable. When deploying below a URL prefix, pass that prefix with the cache path as `basePath`, such as `/app/_vitecache/`; the entry does not infer Vite's base.

The plugin adds the cache directory, `public/_vitecache/`, to `.gitignore`. A Node script outside Vite can use the same loaders, but nothing adds what its loads used, so its entries check only the declared inputs. Its entries use `public/_vitecache/` below the working directory, or below `root` when passed, while `publicURL()` always reads `public/` below the working directory.
