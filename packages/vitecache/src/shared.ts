declare global {
  /** Set by the vitecache Vite plugin. On globalThis, since Vite's module runner can load a second copy of this. */
  var vitecache: Shared | undefined;
}

interface Shared {
  /** The plugin's project. */
  root?: string;
  directory?: string;
  /** When each key was last loaded in this process, which the plugin prunes by. */
  used: Map<string, number>;
  /** How many entries this process saved, which a build's second pass checks. */
  saves: number;
  /** Whether a build is starting the server it runs loaders with. */
  running?: boolean;
}

export const shared: Shared = (globalThis.vitecache ??= { used: new Map(), saves: 0 });
// Another vitecache version in this process may have made it, as when Vite restarts its server after a rebuild.
shared.used ??= new Map();
shared.saves ??= 0;
