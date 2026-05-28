/* eslint-disable no-undef */

import { resolve } from 'path';
import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [glsl(), dts()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'autk-grammar',
    },
    rollupOptions: {
      external: [
        '@urban-toolkit/the-urban-grammar',
        '@urban-toolkit/autk-db',
        '@urban-toolkit/autk-map',
        '@urban-toolkit/autk-plot',
        '@urban-toolkit/autk-compute'
      ],
      output: {
        globals: {
          '@urban-toolkit/the-urban-grammar': 'theUrbanGrammar',
          '@urban-toolkit/autk-db': 'autkDb',
          '@urban-toolkit/autk-map': 'autkMap',
          '@urban-toolkit/autk-plot': 'autkPlot',
          '@urban-toolkit/autk-compute': 'autkCompute',
        },
      },
    },
    copyPublicDir: false,
    emptyOutDir: false,
    sourcemap: true
  },
});
