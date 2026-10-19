import { vitecache } from '@drawcall/vitecache/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vitecache()],
  build: { target: 'es2022' },
});
