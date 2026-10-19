import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { paths } from './dependencies.js';
import type { CacheEntryOptions, Paths } from './types.js';

export function digest(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') throw new TypeError('Cache inputs must contain only JSON values.');
  if (ancestors.has(value)) throw new TypeError('Cache inputs must not contain cycles.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Cache inputs must not contain symbol properties.');
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const property = Object.getOwnPropertyDescriptor(value, index);
        if (!property || !('value' in property)) throw new TypeError('Cache inputs must not contain sparse arrays or getters.');
        const item: unknown = property.value;
        items.push(canonical(item, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Cache inputs must contain only plain JSON objects.');
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Cache inputs must not contain symbol properties.');
    const properties = Object.keys(value).sort().map((name) => {
      const property = Object.getOwnPropertyDescriptor(value, name);
      if (!property || !('value' in property)) throw new TypeError('Cache inputs must not contain getters.');
      const item: unknown = property.value;
      return `${JSON.stringify(name)}:${canonical(item, ancestors)}`;
    });
    return `{${properties.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function identity(options: Pick<CacheEntryOptions, 'version' | 'inputs'>): string {
  if (typeof options.version !== 'string' || !options.version) throw new TypeError('CacheEntry requires a nonempty version.');
  return canonical({ version: options.version, inputs: options.inputs ?? null });
}

export function key(identity: string, files: Paths): string {
  return digest(new TextEncoder().encode(canonical({ identity, fileDependencies: paths(files) })));
}
