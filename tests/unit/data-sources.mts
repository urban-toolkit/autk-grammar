// Unit tests for the data adapter's sources, with a fake autk-db that records every call the adapter makes: what each
// entry of a spec's `data` asks autk-db to do, and what the adapter refuses before autk-db runs. They load the built
// `./data` entry, which a host's server calls. Run after `make build`:
//   npm run test:unit
import assert from 'node:assert/strict';
import { DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';
import type { AutkDb } from '@urban-toolkit/autk-db';
import type { FeatureCollection } from 'geojson';
import { createDataAdapter } from '@urban-toolkit/autk-grammar/data';
import type { DataSourceSpec } from '@urban-toolkit/autk-grammar/data';

/** A call the adapter made: the method's name, then its arguments. */
type Call = [method: string, ...args: unknown[]];

/** A table the fake database holds, as autk-db's metadata gives it. */
type FakeTable = { name: string; type?: string };

/**
 * A fake AutkDb that records the calls the adapter makes and holds the tables `tables` lists. It starts in the default
 * workspace, as autk-db does after `init()`.
 */
function fakeDb(tables: FakeTable[] = []): { db: AutkDb; calls: Call[] } {
    const calls: Call[] = [];
    let current = DEFAULT_WORKSPACE_NAME;
    const recorded = (method: string) => async (...args: unknown[]) => { calls.push([method, ...args]); };
    const db = {
        getCurrentWorkspace: () => current,
        setWorkspace: async (name: string, ...rest: unknown[]) => { calls.push(['setWorkspace', name, ...rest]); current = name; },
        getTablesMetadata: () => tables,
        getLayer: async (name: string) => {
            calls.push(['getLayer', name]);
            return { type: 'FeatureCollection', features: [] };
        },
        loadOsm: recorded('loadOsm'),
        loadCsv: recorded('loadCsv'),
        loadJson: recorded('loadJson'),
        buildHeatmap: recorded('buildHeatmap'),
        rawQuery: recorded('rawQuery'),
        updateTable: recorded('updateTable'),
        removeLayer: recorded('removeLayer'),
    };
    return { db: db as unknown as AutkDb, calls };
}

/** Loads `source` into a fake database holding `tables`, and gives the calls the adapter made. */
async function callsFor(source: unknown, tables?: FakeTable[]): Promise<Call[]> {
    const { db, calls } = fakeDb(tables);
    await createDataAdapter().resolveSource(db, source as DataSourceSpec);
    return calls;
}

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('refuses a source of a type it does not know, rather than hand the next source a new database', async () => {
    const { db } = fakeDb();
    await assert.rejects(
        createDataAdapter().resolveSource(db, { type: 'shapefile', outputTableName: 't' } as unknown as DataSourceSpec),
        { message: 'Unknown data source type "shapefile".' },
    );
});

test('a CSV source still loads into the database it is given', async () => {
    const csv = { type: 'csv', outputTableName: 'c', csvFileUrl: 'rows.csv' };
    const { db, calls } = fakeDb();
    assert.equal(await createDataAdapter().resolveSource(db, csv as DataSourceSpec), db);
    assert.deepEqual(calls, [['loadCsv', { outputTableName: 'c', csvFileUrl: 'rows.csv' }]]);
});

// OpenStreetMap sources, for a box around Wall Street.
const osm = { type: 'osm', outputTableName: 'osm', queryArea: { bbox: [-74.0125, 40.705, -74.008, 40.7085] } };

/** The parameters of the one `loadOsm` call loading `source` makes. */
async function loadOsmParams(source: unknown): Promise<Record<string, unknown>> {
    const calls = await callsFor(source);
    assert.deepEqual(calls.map(([method]) => method), ['loadOsm']);
    return calls[0][1] as Record<string, unknown>;
}

const tagSets = [
    { name: 'cafes', type: 'points', tags: [{ key: 'amenity', value: 'cafe' }] },
    { name: 'paths', type: 'polylines', tags: [{ key: 'highway' }, { key: 'footway', value: 'sidewalk' }] },
];

test('an OSM source hands autk-db its tag sets', async () => {
    const params = await loadOsmParams({ ...osm, tagSets });
    assert.deepEqual(params.tagSets, tagSets);
    // A tag-only source asks for no layer.
    assert.deepEqual(params.autoLoadLayers, { layers: [] });
});

test('refuses tag sets with a PBF extract, naming the source, before autk-db runs', async () => {
    const { db, calls } = fakeDb();
    await assert.rejects(
        createDataAdapter().resolveSource(db, { ...osm, pbfFileUrl: 'area.osm.pbf', tagSets } as DataSourceSpec),
        { message: 'OSM source "osm": tagSets are read from the Overpass API only, so a source with pbfFileUrl cannot take them.' },
    );
    assert.deepEqual(calls, []);
    // An empty list asks for no tag set, so a source with a PBF extract may give one.
    assert.deepEqual((await loadOsmParams({ ...osm, pbfFileUrl: 'area.osm.pbf', tagSets: [] })).tagSets, []);
});

test('an OSM source hands autk-db the CRS of its coordinates, and leaves dropOsmTable out', async () => {
    assert.deepEqual(
        (await loadOsmParams({ ...osm, autoLoadLayers: { layers: ['roads'], coordinateFormat: 'EPSG:4269' } })).autoLoadLayers,
        { layers: ['roads'], coordinateFormat: 'EPSG:4269' },
    );
    assert.deepEqual((await loadOsmParams({ ...osm, autoLoadLayers: { layers: ['roads'], dropOsmTable: true } })).autoLoadLayers, { layers: ['roads'] });
});

test('an OSM source hands autk-db its forceRefresh', async () => {
    assert.equal((await loadOsmParams({ ...osm, forceRefresh: true })).forceRefresh, true);
    assert.equal('forceRefresh' in await loadOsmParams(osm), false);
});

// workspaces: each workspace's CRS and precision grid, set before the first source loads.
const webMercator = { coordinateFormat: 'EPSG:3857', precisionGrid: 1 };
const utm = { coordinateFormat: 'EPSG:32618', precisionGrid: 0.1 };

test('workspaces sets each workspace to its CRS and grid, then leaves the default workspace current', async () => {
    const { db, calls } = fakeDb();
    assert.equal(await createDataAdapter().resolveWorkspaces(db, [webMercator, { name: 'west', ...utm }]), db);
    assert.deepEqual(calls, [
        ['setWorkspace', DEFAULT_WORKSPACE_NAME, webMercator],
        ['setWorkspace', 'west', utm],
        ['setWorkspace', DEFAULT_WORKSPACE_NAME],
    ]);
});

test('refuses a workspace that workspaces sets twice', async () => {
    const adapter = createDataAdapter();
    await assert.rejects(
        adapter.resolveWorkspaces(fakeDb().db, [{ name: 'west', ...utm }, { name: 'west', ...webMercator }]),
        { message: 'workspaces sets the workspace "west" twice; give each workspace one entry.' },
    );
    await assert.rejects(
        adapter.resolveWorkspaces(fakeDb().db, [webMercator, { name: DEFAULT_WORKSPACE_NAME, ...utm }]),
        { message: 'workspaces sets the default workspace twice; give each workspace one entry.' },
    );
});

test("names the workspace whose configuration autk-db refuses", async () => {
    const { db } = fakeDb();
    Object.assign(db, { setWorkspace: async () => { throw new Error('precisionGrid must be a finite number greater than zero.'); } });
    await assert.rejects(
        createDataAdapter().resolveWorkspaces(db, [{ name: 'west', coordinateFormat: 'EPSG:3857', precisionGrid: 0 }]),
        { message: 'workspaces, the workspace "west": precisionGrid must be a finite number greater than zero.' },
    );
});

// sql sources: a SELECT saved as a new table.
const emptyCollection = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

test('a sql source saves its query as a new table, of the layer type it gives', async () => {
    const query = "SELECT * FROM zones WHERE CAST(properties->>'v' AS INTEGER) >= 20";
    assert.deepEqual(await callsFor({ type: 'sql', outputTableName: 'high', query, layerType: 'polygons' }), [
        ['rawQuery', { query, output: { type: 'CREATE_TABLE', tableName: 'high', source: 'user', tableType: 'polygons' } }],
    ]);
    assert.deepEqual(await callsFor({ type: 'sql', outputTableName: 'counts', query: 'SELECT 1 AS one' }), [
        ['rawQuery', { query: 'SELECT 1 AS one', output: { type: 'CREATE_TABLE', tableName: 'counts', source: 'user' } }],
    ]);
});

test('names the sql source whose query autk-db refuses', async () => {
    const { db } = fakeDb();
    Object.assign(db, { rawQuery: async () => { throw new Error('Only SELECT queries are allowed for raw queries.'); } });
    await assert.rejects(
        createDataAdapter().resolveSource(db, { type: 'sql', outputTableName: 'gone', query: 'DROP TABLE zones' } as DataSourceSpec),
        { message: 'SQL source "gone": Only SELECT queries are allowed for raw queries.' },
    );
});

test("a sql source saved under a GeoJSON table's name takes its rows out of the cache the plots read first", async () => {
    const cache = new Map([['zones', emptyCollection()], ['west/zones', emptyCollection()]]);
    await createDataAdapter(undefined, cache).resolveSource(fakeDb().db, { type: 'sql', outputTableName: 'zones', query: 'SELECT * FROM zones' } as DataSourceSpec);
    assert.deepEqual([...cache.keys()], ['west/zones']);
});

// update sources: a table's rows replaced or changed, with rows given inline.
const sales = [{ month: 'Feb', total: 9 }];
const zone = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 'autk-feature-2', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 2, v: 99 } }],
};

test('an update source hands autk-db its rows, its strategy and its id column', async () => {
    assert.deepEqual(await callsFor({ type: 'update', dataRef: 'sales', strategy: 'update', idColumn: 'month', jsonObject: sales }), [
        ['updateTable', { tableName: 'sales', data: sales, strategy: 'update', idColumn: 'month' }],
    ]);
    assert.deepEqual(await callsFor({ type: 'update', dataRef: 'zones', strategy: 'replace', geojsonObject: zone }), [
        ['updateTable', { tableName: 'zones', data: zone, strategy: 'replace' }],
    ]);
});

test('refuses an update source without exactly one set of rows, or an update without an id column, naming the table', async () => {
    const refused = (source: object, message: string) => assert.rejects(callsFor({ type: 'update', dataRef: 'sales', ...source }), { message });
    const rows = 'Update of "sales": give its rows in geojsonObject or in jsonObject, one of the two.';
    await refused({ strategy: 'replace' }, rows);
    await refused({ strategy: 'replace', jsonObject: sales, geojsonObject: zone }, rows);
    await refused({ strategy: 'update', jsonObject: sales }, 'Update of "sales": the update strategy needs an idColumn, the column that matches a given row to the table\'s rows.');
    const { db } = fakeDb();
    Object.assign(db, { updateTable: async () => { throw new Error('Table sales not found.'); } });
    await assert.rejects(
        createDataAdapter().resolveSource(db, { type: 'update', dataRef: 'sales', strategy: 'replace', jsonObject: sales } as DataSourceSpec),
        { message: 'Update of "sales": Table sales not found.' },
    );
});

test('an update puts a layer in the cache the plots read first as autk-db now exports it, and takes a table without a geometry out', async () => {
    const before = emptyCollection();
    const cache = new Map([['zones', before], ['sales', emptyCollection()]]);
    const { db, calls } = fakeDb([{ name: 'zones', type: 'polygons' }, { name: 'sales' }]);
    const adapter = createDataAdapter(undefined, cache);
    await adapter.resolveSource(db, { type: 'update', dataRef: 'zones', strategy: 'update', idColumn: 'properties.id', geojsonObject: zone } as DataSourceSpec);
    await adapter.resolveSource(db, { type: 'update', dataRef: 'sales', strategy: 'replace', jsonObject: sales } as DataSourceSpec);
    assert.deepEqual(calls.map(([method, ...args]) => (method === 'getLayer' ? [method, ...args] : method)), ['updateTable', ['getLayer', 'zones'], 'updateTable']);
    assert.deepEqual([...cache.keys()], ['zones']);
    assert.notStrictEqual(cache.get('zones'), before);
});

// A heatmap's bands, each from an entry of groupBy.
test("a heatmap hands autk-db each band's normalize", async () => {
    const groupBy = [
        { column: 'Unique Key', aggregateFn: 'count' },
        { column: 'Unique Key', aggregateFn: 'count', normalize: true },
    ];
    const heatmap = { type: 'heatmap', outputTableName: 'heat', joinDataRef: 'noise', near: { distance: 500 }, grid: { rows: 4, columns: 4 }, groupBy };
    assert.deepEqual(await callsFor(heatmap), [
        ['buildHeatmap', { tableJoinName: 'noise', near: { distance: 500 }, outputTableName: 'heat', grid: { rows: 4, columns: 4 }, groupBy }],
    ]);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
