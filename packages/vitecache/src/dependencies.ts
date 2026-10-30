import type { Dependencies, Dependency, Hashes, JsonValue, Paths, ResolvedDependencies, ResolvedDependency, SavedDependencies, SavedDependency } from './types.js';

/** A file or package dependency has no backing file or installation, so its state cannot be checked. */
export class MissingDependencyError extends Error {
  override name = 'MissingDependencyError';
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a named dependency record.');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Expected a plain dependency record.');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Dependency names must be strings.');
  return Object.fromEntries(Object.keys(value).sort().map((name) => {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (!property || !('value' in property)) throw new TypeError('Dependency getters are not supported.');
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

export function paths(value: unknown): Paths {
  return Object.freeze(Object.fromEntries(Object.entries(record(value)).map(([name, value]) => {
    if (!name) throw new TypeError('File dependencies require nonempty names.');
    return [name, path(value)];
  })));
}

/** Validate and snapshot JSON before asynchronous dependency resolution starts. */
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

export function dependencies(value: unknown): Dependencies {
  const entries = Object.entries(record(value)).map(([name, value]): [string, Dependency] => {
    if (!name) throw new TypeError('Dependencies require nonempty names.');
    const source = record(value);
    if (Object.keys(source).length !== 1) throw new TypeError('Each dependency must have exactly one value, path, url, or package.');
    if (Object.hasOwn(source, 'value')) return [name, Object.freeze({ value: json(source.value) })];
    if (Object.hasOwn(source, 'path')) return [name, Object.freeze({ path: path(source.path) })];
    if (Object.hasOwn(source, 'url') && typeof source.url === 'string' && source.url && !source.url.includes('\0')) {
      return [name, Object.freeze({ url: source.url })];
    }
    if (Object.hasOwn(source, 'package') && typeof source.package === 'string' && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(source.package)) {
      return [name, Object.freeze({ package: source.package })];
    }
    throw new TypeError('Each dependency must have a JSON value, root-relative path, nonempty URL, or package name without a subpath.');
  });
  return Object.freeze(Object.fromEntries(entries));
}

export function resolvedDependencies(value: unknown): ResolvedDependencies {
  const entries = Object.entries(dependencies(value)).map(([name, dependency]): [string, ResolvedDependency] => {
    if (dependency.url !== undefined) throw new TypeError('Expected resolved dependencies, not URLs.');
    return [name, dependency];
  });
  return Object.freeze(Object.fromEntries(entries));
}

/** Saved dependencies are rechecked later, so they cannot be values: values select the result and belong to the key. */
export function savedDependencies(value: unknown): SavedDependencies {
  const entries = Object.entries(dependencies(value)).map(([name, dependency]): [string, SavedDependency] => {
    if (dependency.value !== undefined) throw new TypeError('Saved dependencies cannot be values: values select the result; pass them to the constructor.');
    return [name, dependency];
  });
  return Object.freeze(Object.fromEntries(entries));
}

export function hashes(value: unknown): Hashes {
  return Object.freeze(Object.fromEntries(Object.entries(record(value)).map(([name, hash]) => {
    if (!name || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new TypeError('Invalid file dependency hash.');
    }
    return [name, hash];
  })));
}

export function equalHashes(first: Hashes, second: Hashes): boolean {
  const names = Object.keys(first);
  return names.length === Object.keys(second).length && names.every((name) => first[name] === second[name]);
}
