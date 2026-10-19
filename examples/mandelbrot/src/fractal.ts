interface Settings {
  width: number;
  height: number;
  iterations: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Escape counts are independent of the display palette, so one precomputation supports many renderings. */
export function compute(settings: Settings): Uint8Array {
  const { width, height, iterations, left, right, top, bottom } = settings;
  const bytes = new Uint8Array(width * height * 2);
  const counts = new DataView(bytes.buffer);
  for (let row = 0; row < height; row++) {
    const imaginary = top + (bottom - top) * row / (height - 1);
    for (let column = 0; column < width; column++) {
      const real = left + (right - left) * column / (width - 1);
      let x = 0;
      let y = 0;
      let count = 0;
      while (x * x + y * y <= 4 && count < iterations) {
        const next = x * x - y * y + real;
        y = 2 * x * y + imaginary;
        x = next;
        count++;
      }
      counts.setUint16((row * width + column) * 2, count, true);
    }
  }
  return bytes;
}
