import { Entry } from './entry.js';
import { createStorage } from './storage.js';
import type { CacheEntryOptions } from './types.js';
export { MissingDependencyError } from './dependencies.js';
export type { CacheEntryOptions, Dependencies, Dependency, JsonValue, SavedDependencies, SavedDependency, SaveOptions } from './types.js';

/** A persistent binary computation result with content-based dependency validation. */
export class CacheEntry extends Entry {
  constructor(options: CacheEntryOptions) {
    super(options, createStorage(options));
  }
}
