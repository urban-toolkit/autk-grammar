/* eslint-disable no-undef */

import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// The `./data` entry: the data adapter alone, for hosts that load a spec's tables without a map. It is built apart
// from vite.config.js, since library mode refuses several entries beside the UMD build that `main` names.
export default defineConfig({
  plugins: [
    dts({
      rollupTypes: true,
      bundledPackages: ['@urban-toolkit/the-urban-grammar'],
      // With one entry, vite-plugin-dts rolls the types up from the file the nearest package.json's `types` names,
      // which is the main entry's. Rooted at the repository, whose package.json names none, it rolls them up from
      // this entry into dist/data/autk-grammar-data.d.ts. That name must not be one of the per-file declarations it
      // writes first (index.d.ts, for one, is src/index.ts's), or the rollup would start from that file.
      root: resolve(__dirname, '../..'),
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
      outDir: resolve(__dirname, 'dist/data'),
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/data-entry.ts'),
      formats: ['es', 'cjs'],
      fileName: 'autk-grammar-data',
    },
    outDir: 'dist/data',
    rollupOptions: {
      // Never bundled: an import of any of them stays in the output, where tests/unit/data-entry.mts finds it.
      external: [
        '@urban-toolkit/autk-core',
        '@urban-toolkit/autk-db',
        '@urban-toolkit/autk-map',
        '@urban-toolkit/autk-plot',
        '@urban-toolkit/autk-compute'
      ],
    },
    copyPublicDir: false,
    sourcemap: true
  },
});
