import { CacheEntry } from '@drawcall/vitecache';
import { settings } from './settings.ts';

export function createEntry(): CacheEntry {
  return new CacheEntry({
    version: 'mandelbrot@1',
    inputs: settings,
    fileDependencies: {
      algorithm: { path: 'src/fractal.ts' },
      settings: { path: 'src/settings.ts' },
    },
  });
}
