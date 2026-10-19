import { createEntry } from './entry.ts';
import { compute } from './fractal.ts';
import { settings } from './settings.ts';

const start = performance.now();
const entry = createEntry();
let bytes = await entry.load();
if (bytes !== undefined) {
  console.log(`Mandelbrot cache ready: ${bytes.byteLength.toLocaleString()} bytes (${Math.round(performance.now() - start)} ms).`);
} else {
  bytes = compute(settings);
  await entry.save(bytes);
  console.log(`Precomputed ${settings.width} × ${settings.height} escape counts in ${Math.round(performance.now() - start)} ms. Saved to public/_vitecache/.`);
}
