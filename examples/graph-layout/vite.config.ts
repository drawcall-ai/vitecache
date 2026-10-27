import { vitecache } from 'vitecache/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vitecache()],
  build: { target: 'es2022' },
});
