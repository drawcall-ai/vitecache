import type { FileDependencies, FileDependency, Hashes, Paths } from './types.js';

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

export function dependencies(value: unknown): FileDependencies {
  const entries = Object.entries(record(value)).map(([name, value]): [string, FileDependency] => {
    if (!name) throw new TypeError('File dependencies require nonempty names.');
    const locator = record(value);
    const keys = Object.keys(locator);
    if (keys.length !== 1) throw new TypeError('Each file dependency must have exactly one path or url.');
    if ('path' in locator) return [name, Object.freeze({ path: path(locator.path) })];
    if ('url' in locator && typeof locator.url === 'string' && locator.url && !locator.url.includes('\0')) {
      return [name, Object.freeze({ url: locator.url })];
    }
    throw new TypeError('Each file dependency must have a nonempty path or url.');
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
