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
// @version      2.0.2
// @description  Automatically backup Tieba posts in one single click
// @author       ZXPrism
// @license      MIT
// @match        https://tieba.baidu.com/p/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      gss0.bdstatic.com
// @connect      gss1.bdstatic.com
// @connect      gss2.bdstatic.com
// @connect      gss3.bdstatic.com
// @connect      gss4.bdstatic.com
// @connect      gsp0.baidu.com
// @connect      himg.bdimg.com
// @connect      tb0.bdstatic.com
// @connect      tb1.bdstatic.com
// @connect      tb2.bdstatic.com
// @connect      tiebapic.baidu.com
// @connect      imgsa.baidu.com
// @connect      static.tieba.baidu.com
// @connect      tieba.baidu.com
// @run-at       document-idle
// ==/UserScript==`,
  },
});
