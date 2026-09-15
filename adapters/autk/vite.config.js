/* eslint-disable no-undef */

import { resolve } from 'path';
import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import dts from 'vite-plugin-dts';

export default defineConfig({
  // The grammar spec is bundled into this package (code and types), so consumers only install autk-grammar.
  plugins: [glsl(), dts({ rollupTypes: true, bundledPackages: ['@urban-toolkit/the-urban-grammar'] })],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'autk-grammar',
    },
    rollupOptions: {
      external: [
        '@urban-toolkit/autk-core',
        '@urban-toolkit/autk-db',
        '@urban-toolkit/autk-map',
        '@urban-toolkit/autk-plot',
        '@urban-toolkit/autk-compute'
      ],
      output: {
        globals: {
          '@urban-toolkit/autk-core': 'autkCore',
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
