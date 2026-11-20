// Unit tests for `writeBack`: what a compute pass with it asks of autk-db, with a fake autk-db that records every call,
// and what it refuses. The browser tests run it against autk-db itself. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import { DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';
import type { AutkDb } from '@urban-toolkit/autk-db';
import type { FeatureCollection, Polygon } from 'geojson';
import type { ClustersComputeSpec } from '@urban-toolkit/the-urban-grammar';
import { EMPTY_LAYER_QUERY, writeBack } from '../../adapters/autk/src/write-back.ts';
import { createComputeAdapter } from '../../adapters/autk/src/adapters/compute.ts';

/** A call the code made: the method's name, then its arguments. */
type Call = [method: string, ...args: unknown[]];
type FakeTable = { name: string; type?: string; columns?: Array<{ name: string; type: string }> };

const square = (x: number): Polygon => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]]] });
const squares: FeatureCollection = {
    type: 'FeatureCollection',
    features: [0, 10, 100].map((x, i) => ({ type: 'Feature', id: `autk-feature-${i}`, properties: { i }, geometry: square(x) })),
};
const geojsonColumns = ['id', 'geojson_id', 'geometry', 'properties'].map((name) => ({ name, type: name === 'geometry' ? 'GEOMETRY' : 'JSON' }));
const osmColumns = ['id', 'building_id', 'geometry', 'properties', '__autk_osm_elements'].map((name) => ({ name, type: name === 'geometry' ? 'GEOMETRY' : 'JSON' }));

/**
 * A fake AutkDb holding `tables`, whose exports are `layers`, that records every call. A count query answers `rows`
 * rows, as DuckDB counts them (a BigInt), and any other query answers no rows.
 */
function fakeDb(tables: FakeTable[], rows: number, layers: Record<string, FeatureCollection> = {}): { db: AutkDb; calls: Call[] } {
    const calls: Call[] = [];
    const db = {
        getCurrentWorkspace: () => DEFAULT_WORKSPACE_NAME,
        setWorkspace: async (...args: unknown[]) => { calls.push(['setWorkspace', ...args]); },
        getTablesMetadata: () => tables.map((table) => ({ columns: [], ...table })),
        getLayer: async (name: string) => { calls.push(['getLayer', name]); return layers[name] ?? { type: 'FeatureCollection', features: [] }; },
        updateTable: async (...args: unknown[]) => { calls.push(['updateTable', ...args]); },
        rawQuery: async (params: { query: string }) => {
            calls.push(['rawQuery', params]);
            return params.query.startsWith('SELECT count(*)') ? [{ n: BigInt(rows) }] : [];
        },
    };
    return { db: db as unknown as AutkDb, calls };
}

const countQuery = (name: string) => ['rawQuery', { query: `SELECT count(*) AS n FROM "${name}"`, output: { type: 'RETURN_OBJECT' } }];

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("in place, it updates each row of a GeoJSON table by its geojson_id, then counts the table's rows", async () => {
    const { db, calls } = fakeDb([{ name: 'squares', type: 'polygons', columns: geojsonColumns }], 3);
    await writeBack(db, 'Pass', 'squares', squares, 'polygons', true);
    assert.deepEqual(calls, [
        ['updateTable', { tableName: 'squares', data: squares, strategy: 'update', idColumn: 'geojson_id' }],
        countQuery('squares'),
    ]);
});

test("in place, it updates each row of an OSM table by its id, the id autk-db's export gives an OSM row", async () => {
    const { db, calls } = fakeDb([{ name: 'box_buildings', type: 'buildings', columns: osmColumns }], 3);
    await writeBack(db, 'Pass', 'box_buildings', squares, 'buildings', true);
    assert.deepEqual(calls[0], ['updateTable', { tableName: 'box_buildings', data: squares, strategy: 'update', idColumn: 'id' }]);
});

test('a new table is created empty, of its layer type, then every row is written in, with no cut to the workspace', async () => {
    const { db, calls } = fakeDb([{ name: 'squares', type: 'polygons', columns: geojsonColumns }], 3);
    await writeBack(db, 'Pass', 'blocks', squares, 'polygons', false);
    assert.deepEqual(calls, [
        ['rawQuery', { query: EMPTY_LAYER_QUERY, output: { type: 'CREATE_TABLE', tableName: 'blocks', source: 'user', tableType: 'polygons' } }],
        ['updateTable', { tableName: 'blocks', data: squares, strategy: 'replace' }],
        countQuery('blocks'),
    ]);
});

test('in place over a table autk-db does not hold, such as one a pass wrote without writeBack, it writes a new table', async () => {
    const { db, calls } = fakeDb([], 3);
    await writeBack(db, 'Pass', 'w', squares, 'points', true);
    assert.deepEqual(calls.map(([method]) => method), ['rawQuery', 'updateTable', 'rawQuery']);
    assert.deepEqual(calls[1], ['updateTable', { tableName: 'w', data: squares, strategy: 'replace' }]);
});

test("refuses a table whose rows autk-db does not all keep, naming the pass and both counts", async () => {
    const { db } = fakeDb([], 2);
    await assert.rejects(writeBack(db, 'Windows pass "w"', 'w', squares, 'points', false), {
        message: 'Windows pass "w": autk-db holds 2 rows of "w" where the pass wrote 3, so its table and the one maps and plots draw would differ.',
    });
});

test('refuses a raster, and a new table of no layer type, before it asks autk-db anything', async () => {
    const raster = fakeDb([{ name: 'heat', type: 'raster' }], 1);
    await assert.rejects(writeBack(raster.db, 'GPGPU pass over "heat"', 'heat', squares, 'raster', true), {
        message: 'GPGPU pass over "heat": writeBack keeps a table of features in autk-db, and "heat" is a raster.',
    });
    assert.deepEqual(raster.calls, []);
    const untyped = fakeDb([{ name: 'rows' }], 3);
    await assert.rejects(writeBack(untyped.db, 'GPGPU pass over "rows"', 'out', squares, undefined, false), {
        message: 'GPGPU pass over "rows": writeBack keeps "out" in autk-db as a layer, and the grammar knows no layer type for it: set the pass\'s layerType.',
    });
    assert.deepEqual(untyped.calls, []);
});

test("names the pass when autk-db refuses the rows", async () => {
    const { db } = fakeDb([{ name: 'squares', type: 'polygons', columns: geojsonColumns }], 3);
    (db as unknown as { updateTable: () => Promise<void> }).updateTable = async () => { throw new Error('Duplicate GeoJSON feature ID: "a"'); };
    await assert.rejects(writeBack(db, 'Clusters pass over "squares"', 'squares', squares, 'polygons', true), {
        message: 'Clusters pass over "squares": autk-db could not keep "squares": Duplicate GeoJSON feature ID: "a"',
    });
});

test('the compute adapter writes a pass back only with writeBack, and keeps its result in the cache either way', async () => {
    const pass: ClustersComputeSpec = { type: 'clusters', dataRef: 'squares', outputColumnName: 'cluster' };
    for (const writeBackKey of [undefined, false, true]) {
        const cache = new Map<string, FeatureCollection>();
        const { db, calls } = fakeDb([{ name: 'squares', type: 'polygons', columns: geojsonColumns }], 3, { squares });
        await createComputeAdapter(cache).resolveCompute(db, { ...pass, ...(writeBackKey !== undefined && { writeBack: writeBackKey }) });
        const written = calls.filter(([method]) => method === 'updateTable');
        assert.equal(written.length, writeBackKey ? 1 : 0, `writeBack: ${writeBackKey}`);
        assert.deepEqual(cache.get('squares')?.features.map((feature) => feature.properties?.compute?.cluster), [0, 0, 1]);
        if (writeBackKey) assert.deepEqual(written[0][1], { tableName: 'squares', data: cache.get('squares'), strategy: 'update', idColumn: 'geojson_id' });
    }
    // Into a new table, of the type of the table the pass read.
    const { db, calls } = fakeDb([{ name: 'squares', type: 'polygons', columns: geojsonColumns }], 3, { squares });
    await createComputeAdapter(new Map()).resolveCompute(db, { ...pass, outputTableName: 'blocks', writeBack: true });
    assert.deepEqual((calls.find(([method]) => method === 'rawQuery')![1] as { output: unknown }).output,
        { type: 'CREATE_TABLE', tableName: 'blocks', source: 'user', tableType: 'polygons' });
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
