import { defineConfig } from 'vite';
import path from 'path';

// Test page that runs gallery example specs through the grammar source (not the built packages),
// against whichever Autark packages are installed.
export default defineConfig({
    root: __dirname,
    publicDir: path.resolve(__dirname, '../../gallery/public'),
    resolve: {
        alias: {
            '@urban-toolkit/autk-grammar': path.resolve(__dirname, '../../adapters/autk/src/index.ts'),
            '@urban-toolkit/the-urban-grammar': path.resolve(__dirname, '../../grammar/src/index.ts'),
        },
    },
    optimizeDeps: {
        exclude: ['@urban-toolkit/autk-db', '@duckdb/duckdb-wasm'],
    },
    server: {
        fs: { allow: [path.resolve(__dirname, '../..')] },
    },
});
