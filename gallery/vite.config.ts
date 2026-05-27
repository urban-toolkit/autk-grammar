import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@urban-toolkit/deckgl-grammar': path.resolve(__dirname, '../adapters/deckgl/src/index.ts'),
    },
  },
  optimizeDeps: {
    exclude: [
      '@urban-toolkit/the-urban-grammar',
      '@urban-toolkit/autk-grammar',
      '@urban-toolkit/autk-db',
      '@urban-toolkit/deckgl-grammar',
      '@duckdb/duckdb-wasm',
    ],
  },
  server: {
    fs: { allow: ['..'] },
    open: '/',
    cors: {
      origin: '*',
      allowedHeaders: 'Range, Content-Type, Authorization',
      exposedHeaders: 'Content-Range',
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
