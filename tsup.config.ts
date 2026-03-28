import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['iife'],
  outDir: 'dist',
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  external: ['JSZip'], // Don't bundle JSZip - it'll be provided by Tampermonkey
  target: 'es2020',
});
