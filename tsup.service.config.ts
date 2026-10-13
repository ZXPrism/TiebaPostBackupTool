import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: { page: 'src/service/page-entry.ts' },
        format: ['iife'], globalName: 'TiebaPage', outDir: 'dist/service',
        target: 'es2020', clean: true, splitting: false,
        outExtension: () => ({ js: '.js' }),
    },
    {
        entry: { app: 'src/web/app.ts' },
        format: ['iife'], outDir: 'dist/web', target: 'es2020', clean: true,
        outExtension: () => ({ js: '.js' }),
    },
]);
