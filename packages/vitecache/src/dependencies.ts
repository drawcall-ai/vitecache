import type { CacheEntryOptions, Dependencies, Dependency, Hashable, JsonValue, Resolved, SavedDependencies, SavedDependency } from './types.js';

/** A file or package dependency has no backing file or installation, so its state cannot be checked. */
export class MissingDependencyError extends Error {
  override name = 'MissingDependencyError';
}

/** A plain object of named entries, sorted by name. */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an object of named entries.');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Expected a plain object of named entries.');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Entry names must be strings.');
  return Object.fromEntries(Object.keys(value).sort().map((name) => {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (!property || !('value' in property)) throw new TypeError('Getters are not supported.');
    const item: unknown = property.value;
    return [name, item];
  }));
}

function path(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new TypeError('File dependencies require nonempty paths.');
  if (/^(?:[\\/]|[a-z]:|[a-z][a-z\d+.-]*:\/\/)/i.test(value)) {
    throw new TypeError('File dependency paths must be relative to the project root.');
  }
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part !== '..') {
      parts.push(part);
      continue;
    }
    if (!parts.length) throw new TypeError('File dependency paths must stay inside the project root.');
    parts.pop();
  }
  if (!parts.length) throw new TypeError('File dependencies must identify files, not the project root.');
  return parts.join('/');
}

/** Served pathnames mapped to project-root-relative paths. */
export function paths(value: unknown): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(record(value)).map(([name, value]) => {
    if (!name) throw new TypeError('File dependencies require nonempty names.');
    return [name, path(value)];
  })));
}

/** A frozen copy of JSON with sorted names, so that the key neither depends on order nor changes after declaration. */
export function json(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new TypeError('Dependency values must contain only JSON values.');
  if (ancestors.has(value)) throw new TypeError('Dependency values must not contain cycles.');
  ancestors.add(value);
  try {
    if (!Array.isArray(value)) return Object.freeze(Object.fromEntries(Object.entries(record(value)).map(([name, item]) => [name, json(item, ancestors)])));
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Dependency values must not contain symbol properties.');
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
      const property = Object.getOwnPropertyDescriptor(value, index);
      if (!property || !('value' in property)) throw new TypeError('Dependency values must not contain sparse arrays or getters.');
      const item: unknown = property.value;
      items.push(json(item, ancestors));
    }
    return Object.freeze(items);
  } finally {
    ancestors.delete(value);
  }
}

export function dependency(value: unknown): Dependency {
  const source = record(value);
  if (Object.keys(source).length !== 1) throw new TypeError('Each dependency must have exactly one value, path, url, or package.');
  if (Object.hasOwn(source, 'value')) return Object.freeze({ value: json(source.value) });
  if (Object.hasOwn(source, 'path')) return Object.freeze({ path: path(source.path) });
  if (Object.hasOwn(source, 'url') && typeof source.url === 'string' && source.url && !source.url.includes('\0')) {
    return Object.freeze({ url: source.url });
  }
  if (Object.hasOwn(source, 'package') && typeof source.package === 'string' && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(source.package)) {
    return Object.freeze({ package: source.package });
  }
  throw new TypeError('Each dependency must have a JSON value, root-relative path, nonempty URL, or package name without a subpath.');
}

/** Validated, frozen named dependencies, sorted by name. */
export function dependencies(value: unknown): Dependencies {
  return Object.freeze(Object.fromEntries(Object.entries(record(value)).map(([name, item]) => {
    if (!name) throw new TypeError('Dependencies require nonempty names.');
    return [name, dependency(item)];
  })));
}

export function isHashable(dependency: Dependency): dependency is Hashable {
  return dependency.value === undefined && dependency.url === undefined;
}

function isResolved(dependency: Dependency): dependency is Resolved {
  return dependency.url === undefined;
}

function isSaved(dependency: Dependency): dependency is SavedDependency {
  return dependency.value === undefined;
}

function only<D extends Dependency>(value: unknown, keep: (dependency: Dependency) => dependency is D, message: string): Dependencies<D> {
  const kept: Record<string, D> = {};
  for (const [name, item] of Object.entries(dependencies(value))) {
    if (!keep(item)) throw new TypeError(message);
    kept[name] = item;
  }
  return Object.freeze(kept);
}

/** Dependencies as the Vite plugin answers a resolution: every URL resolved to a path. */
export function resolvedDependencies(value: unknown): Dependencies<Resolved> {
  return only(value, isResolved, 'Expected resolved dependencies, not URLs.');
}

/** Saved dependencies are rechecked later, so they cannot be values: values select the result and belong to the key. */
export function savedDependencies(value: unknown): SavedDependencies {
  return only(value, isSaved, 'Saved dependencies cannot be values: values select the result; pass them to the constructor.');
}

/** An entry's validated declaration, copied so that later changes to the caller's objects cannot change its key. */
export function declaration(options: CacheEntryOptions): { version: string; dependencies: Dependencies } {
  if (typeof options.version !== 'string' || !options.version) throw new TypeError('CacheEntry requires a nonempty version.');
  return { version: options.version, dependencies: dependencies(options.dependencies ?? {}) };
}
