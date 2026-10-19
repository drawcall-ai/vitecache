import { createEntry } from './entry.ts';
import { compute } from './fractal.ts';
import { settings } from './settings.ts';
import './style.css';

const canvas = document.querySelector('canvas');
const palette = document.querySelector('input');
const reload = document.querySelector('button');
const result = document.querySelector('#result');
const preparation = document.querySelector('#preparation');
const rendering = document.querySelector('#rendering');
const status = document.querySelector('[role="status"]');
if (!canvas || !palette || !reload || !result || !preparation || !rendering || !status) throw new Error('Missing example controls.');
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D is unavailable.');
canvas.width = settings.width;
canvas.height = settings.height;
const ui = { palette, reload, result, preparation, rendering, status, context };
const image = context.createImageData(settings.width, settings.height);
let counts: DataView | undefined;

function render(): void {
  if (!counts) return;
  const start = performance.now();
  const hue = Number(ui.palette.value) * Math.PI / 180;
  for (let pixel = 0; pixel < settings.width * settings.height; pixel++) {
    const count = counts.getUint16(pixel * 2, true);
    const angle = Math.log1p(count) * 2 + hue;
    const interior = count === settings.iterations;
    image.data[pixel * 4] = interior ? 12 : 128 + 112 * Math.cos(angle);
    image.data[pixel * 4 + 1] = interior ? 17 : 128 + 112 * Math.cos(angle + 2.094);
    image.data[pixel * 4 + 2] = interior ? 21 : 128 + 112 * Math.cos(angle + 4.189);
    image.data[pixel * 4 + 3] = 255;
  }
  ui.context.putImageData(image, 0, 0);
  ui.rendering.textContent = `${(performance.now() - start).toFixed(1)} ms`;
}

async function load(): Promise<void> {
  ui.reload.disabled = true;
  ui.palette.disabled = true;
  ui.status.textContent = 'Loading escape counts…';
  const start = performance.now();
  const entry = createEntry();
  let bytes = await entry.load();
  const cached = bytes !== undefined;
  if (bytes === undefined) {
    ui.status.textContent = 'Computing escape counts…';
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    bytes = compute(settings);
    await entry.save(bytes);
  }
  if (bytes.byteLength !== settings.width * settings.height * 2) throw new Error('Invalid escape-count cache size.');
  ui.preparation.textContent = `${(performance.now() - start).toFixed(1)} ms`;
  ui.result.textContent = cached ? 'Loaded from cache' : 'Computed from scratch';
  counts = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  render();
  ui.palette.disabled = false;
  ui.reload.disabled = false;
  ui.reload.textContent = 'Load again';
  ui.status.textContent = cached
    ? 'Cached counts are ready. Change the palette without recomputing the fractal.'
    : 'Counts computed. Load again to compare with a cache hit.';
}

function showError(error: unknown): void {
  ui.reload.disabled = false;
  ui.reload.textContent = 'Try again';
  ui.status.textContent = `Unable to prepare the fractal: ${error instanceof Error ? error.message : String(error)}. Check the console, then reload to retry.`;
  console.error(error);
}

palette.addEventListener('input', render);
reload.addEventListener('click', () => { void load().catch(showError); });
void load().catch(showError);
