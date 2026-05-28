/* eslint-disable no-undef */

import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'deckgl-grammar',
    },
    rollupOptions: {
      external: [
        '@urban-toolkit/the-urban-grammar',
        'deck.gl',
        '@observablehq/plot',
        'papaparse',
      ],
      output: {
        globals: {
          '@urban-toolkit/the-urban-grammar': 'theUrbanGrammar',
          'deck.gl': 'deck_gl',
          '@observablehq/plot': 'Plot',
          'papaparse': 'Papa',
        },
      },
    },
    copyPublicDir: false,
    emptyOutDir: false,
    sourcemap: true
  },
});
