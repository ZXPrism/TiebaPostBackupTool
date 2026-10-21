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
  target: 'es2020',
  banner: {
    js: `// ==UserScript==
// @name         Tieba Post Backup Tool
// @namespace    https://github.com/ZXPrism/TiebaPostBackupTool
// @version      2.1.0
// @description  Automatically backup Tieba posts in one single click
// @author       ZXPrism
// @license      MIT
// @match        https://tieba.baidu.com/*
// @run-at       document-idle
// ==/UserScript==`,
  },
});
