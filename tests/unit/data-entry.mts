// Unit tests for the package's `./data` entry, which hosts use to load a spec's tables without a map: it loads in
// Node with autk-db as its only import, and names tables as the grammar's caches do. Run after `make build`:
//   npm run test:unit
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';
import type { AutkDb } from '@urban-toolkit/autk-db';

type DataEntry = typeof import('@urban-toolkit/autk-grammar/data');

const SPECIFIER = '@urban-toolkit/autk-grammar/data';
const adapterDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'adapters', 'autk');
const files: { types: string, import: string, require: string } =
    JSON.parse(readFileSync(join(adapterDir, 'package.json'), 'utf8')).exports['./data'];
const require = createRequire(import.meta.url);

// What a map, a plot or a compute pass needs, which a host without a GPU or a page may not be able to load, and the
// grammar's own package, which is bundled in and not published.
const NOT_IMPORTED = [
    '@urban-toolkit/autk-map',
    '@urban-toolkit/autk-plot',
    '@urban-toolkit/autk-compute',
    '@urban-toolkit/autk-core',
    '@urban-toolkit/the-urban-grammar',
];

/** The packages a built file imports or requires, by name. */
function importedPackages(file: string): string[] {
    const code = readFileSync(join(adapterDir, file), 'utf8');
    const names = new Set<string>();
    for (const [, specifier] of code.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g))
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) names.add(specifier);
    return [...names].sort();
}

const loaded = async (): Promise<Array<[string, DataEntry]>> => [
    ['ES module', await import(SPECIFIER) as DataEntry],
    ['CommonJS module', require(SPECIFIER) as DataEntry],
];

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('package.json names the types, the ES module and the CommonJS module of ./data, all in dist/data', () => {
    assert.equal(files.types, './dist/data/autk-grammar-data.d.ts');
    assert.equal(files.import, './dist/data/autk-grammar-data.js');
    assert.equal(files.require, './dist/data/autk-grammar-data.cjs');
    assert.equal(require.resolve(SPECIFIER), realpathSync(join(adapterDir, files.require)));
});

test('both builds load in Node and export createDataAdapter, enterWorkspace and tableKey', async () => {
    for (const [build, entry] of await loaded()) {
        for (const name of ['createDataAdapter', 'enterWorkspace', 'tableKey'] as const)
            assert.equal(typeof entry[name], 'function', `${build}: ${name}`);
        assert.equal(typeof entry.createDataAdapter().resolveSource, 'function', `${build}: resolveSource`);
    }
});

test('the built files import autk-db and nothing of autk-map, autk-plot, autk-compute or autk-core', () => {
    for (const file of [files.import, files.require, files.types]) {
        const imported = importedPackages(file);
        for (const name of NOT_IMPORTED) assert.ok(!imported.includes(name), `${file} imports ${name}`);
        // The types also import geojson's; the code imports autk-db alone.
        if (file !== files.types) assert.deepEqual(imported, ['@urban-toolkit/autk-db'], file);
    }
});

test("tableKey names a table by its name in the default workspace, and <workspace>/<name> in another", async () => {
    for (const [build, { tableKey }] of await loaded()) {
        assert.equal(tableKey(undefined, 'roads'), 'roads', build);
        assert.equal(tableKey(DEFAULT_WORKSPACE_NAME, 'roads'), 'roads', build);
        assert.equal(tableKey('west', 'roads'), 'west/roads', build);
        assert.equal(tableKey('east', 'roads'), 'east/roads', build);
    }
});

test('enterWorkspace switches the database only when another workspace is current', async () => {
    for (const [build, { enterWorkspace }] of await loaded()) {
        let current = DEFAULT_WORKSPACE_NAME;
        const switched: string[] = [];
        const db = {
            getCurrentWorkspace: () => current,
            setWorkspace: async (name: string) => { switched.push(name); current = name; },
        } as unknown as AutkDb;
        await enterWorkspace(db);
        await enterWorkspace(db, DEFAULT_WORKSPACE_NAME);
        assert.deepEqual(switched, [], `${build}: already in the default workspace`);
        await enterWorkspace(db, 'west');
        await enterWorkspace(db, 'west');
        assert.deepEqual(switched, ['west'], `${build}: into west once`);
        await enterWorkspace(db);
        assert.deepEqual(switched, ['west', DEFAULT_WORKSPACE_NAME], `${build}: back to the default workspace`);
    }
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
