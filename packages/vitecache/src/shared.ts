declare global {
  /** Set by the vitecache Vite plugin. On globalThis, since Vite's module runner can load a second copy of this. */
  var vitecache: Shared | undefined;
}

/** Node: a project root and its publicDir, which holds the cache directory. */
interface Project {
  root: string;
  publicDir: string;
}

interface Shared {
  /** The plugin's project. */
  project?: Project;
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

/** Node: the project at `root`; without one, the plugin's while it runs in this process, else the working directory. */
export function project(root?: string): Project {
  if (root === undefined && shared.project) return shared.project;
  root ??= process.cwd();
  return { root, publicDir: `${root}/public` };
}

/**
 * The URL a loader reads a public file at. In Node, a root-absolute path such as `/tree/model.glts` becomes the `file:`
 * URL of that file below publicDir; browsers already load public files by their URL, so there it is unchanged.
 */
export function publicURL(url: string): string {
  // Only Node, and runtimes compatible with it, read public files from disk rather than over HTTP.
  if (!globalThis.process?.versions?.node || !url.startsWith('/') || url.startsWith('//')) return url;
  const path = `${project().publicDir}${url}`.replaceAll('\\', '/');
  const file = new URL('file:///');
  // The setter escapes what a path cannot hold literally except `%`; a Windows drive letter starts the path.
  file.pathname = `${/^[A-Za-z]:/.test(path) ? '/' : ''}${path.replaceAll('%', '%25')}`;
  return file.href;
}
