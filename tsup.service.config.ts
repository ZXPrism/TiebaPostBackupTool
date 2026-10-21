import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: { app: 'src/web/app.ts' },
        format: ['iife'], outDir: 'dist/web', target: 'es2020', clean: true,
        outExtension: () => ({ js: '.js' }),
    },
]);
