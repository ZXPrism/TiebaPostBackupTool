import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: { app: 'src/service/web/app.ts' },
        format: ['iife'], outDir: 'dist/service/web', target: 'es2020', clean: true,
        outExtension: () => ({ js: '.js' }),
    },
]);
