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
type FakeTable = { name: string; type?: string; columns?: Array<{ name: string; type: string }> };

/**
 * A fake AutkDb that records the calls the adapter makes and holds the tables `tables` lists, whose exports are
 * `layers` (an empty collection for a table it does not name). It starts in the default workspace, as autk-db does
 * after `init()`.
 */
function fakeDb(tables: FakeTable[] = [], layers: Record<string, FeatureCollection> = {}): { db: AutkDb; calls: Call[] } {
    const calls: Call[] = [];
    let current = DEFAULT_WORKSPACE_NAME;
    const recorded = (method: string) => async (...args: unknown[]) => { calls.push([method, ...args]); };
    const db = {
        getCurrentWorkspace: () => current,
        setWorkspace: async (name: string, ...rest: unknown[]) => { calls.push(['setWorkspace', name, ...rest]); current = name; },
        getTablesMetadata: () => tables.map((table) => ({ columns: [], ...table })),
        getLayer: async (name: string) => {
            calls.push(['getLayer', name]);
            return layers[name] ?? { type: 'FeatureCollection', features: [] };
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

// autk-db 4.1.1 puts the geometry of a table a query saves on the workspace's grid, read from a column named geometry,
// with a layerType or without one: a query that returns its geometry under another name fails there, with DuckDB's
// binder error for a column named geometry. A query that reads a geometry column its table lacks fails with the same
// error, so the advice holds for both.
test("tells a sql source that DuckDB finds no geometry column for to name a geometry it returns geometry, and keeps autk-db's reason", async () => {
    const refused = async (query: string, bindings: string) => {
        const binder = `Binder Error: Referenced column "geometry" not found in FROM clause!\nCandidate bindings: ${bindings}`;
        const { db } = fakeDb();
        Object.assign(db, { rawQuery: async () => { throw new Error(binder); } });
        await assert.rejects(
            createDataAdapter().resolveSource(db, { type: 'sql', outputTableName: 'centers', query } as DataSourceSpec),
            { message: `SQL source "centers": if the query returns a geometry, name it geometry, for example ST_Centroid(geometry) AS geometry. autk-db: ${binder}` },
        );
    };
    // The query returns its geometry under another name.
    await refused("SELECT properties->>'ntaname' AS name, ST_Centroid(geometry) AS center FROM neighborhoods", '"center", "name"');
    // The query reads a geometry from a table of plain columns, which has none.
    await refused('SELECT zone, geometry FROM counts', '"zone", "count"');
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

// A GeoJSON layer's columns, and its four zones as autk-db exports them: each under its feature id, valued id * 10.
const geojsonColumns = ['id', 'geojson_id', 'geometry', 'properties'].map((name) => ({ name, type: name === 'geometry' ? 'GEOMETRY' : 'JSON' }));
const zoneRows = (ids: Array<string | number | null>, keys: unknown[] = [0, 1, 2, 3]): FeatureCollection => ({
    type: 'FeatureCollection',
    features: ids.map((id, i) => ({
        type: 'Feature', ...(id !== null && { id }), geometry: { type: 'Point', coordinates: [i, 0] }, properties: { id: keys[i], v: i * 10 },
    })),
});
const zoneIds = ['autk-feature-0', 'autk-feature-1', 'autk-feature-2', 'autk-feature-3'];

test('an update puts a layer in the cache the plots read first as autk-db now exports it, and takes a table without a geometry out', async () => {
    const before = emptyCollection();
    const cache = new Map([['zones', before], ['sales', emptyCollection()]]);
    const { db, calls } = fakeDb([{ name: 'zones', type: 'polygons', columns: geojsonColumns }, { name: 'sales' }], { zones: zoneRows(zoneIds) });
    const adapter = createDataAdapter(undefined, cache);
    await adapter.resolveSource(db, { type: 'update', dataRef: 'zones', strategy: 'update', idColumn: 'properties.id', geojsonObject: zone } as DataSourceSpec);
    await adapter.resolveSource(db, { type: 'update', dataRef: 'sales', strategy: 'replace', jsonObject: sales } as DataSourceSpec);
    // The zones are read to match the key, updated, and read again for the cache; the sales are updated alone.
    assert.deepEqual(
        calls.map(([method, ...args]) => (method === 'getLayer' ? [method, ...args] : method)),
        [['getLayer', 'zones'], 'updateTable', ['getLayer', 'zones'], 'updateTable'],
    );
    assert.deepEqual([...cache.keys()], ['zones']);
    assert.notStrictEqual(cache.get('zones'), before);
});

// autk-db 4.1.1 matches a `properties.<name>` key with `table.properties->>'name' = staging.properties->>'name'`, which
// DuckDB reads so that the comparison is NULL: a layer update keyed by a property changed no row. The adapter matches
// the key itself and hands autk-db the rows keyed by their feature ids, a plain column it compares as written.
test('a layer update keyed by a feature property reaches autk-db keyed by the feature ids of the rows it matches', async () => {
    const changed = { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { id: 2, v: 99 } };
    const { db, calls } = fakeDb([{ name: 'zones', type: 'polygons', columns: geojsonColumns }], { zones: zoneRows(zoneIds) });
    await createDataAdapter().resolveSource(db, {
        type: 'update', dataRef: 'zones', strategy: 'update', idColumn: 'properties.id', geojsonObject: { type: 'FeatureCollection', features: [changed] },
    } as DataSourceSpec);
    assert.deepEqual(calls, [
        ['getLayer', 'zones'],
        ['updateTable', { tableName: 'zones', strategy: 'update', idColumn: 'geojson_id', data: { type: 'FeatureCollection', features: [{ ...changed, id: 'autk-feature-2' }] } }],
    ]);
});

test("a layer update goes to every row a key matches, compares keys as text, and uses the rows' id without a geojson_id", async () => {
    // An OSM-like table, whose export names each row by its id: rows 101 and 102 share the key "primary", and row 103's
    // key, the number 5, reads as the text "5", which the given string matches.
    const columns = ['id', 'properties', 'geometry'].map((name) => ({ name, type: name === 'id' ? 'BIGINT' : 'JSON' }));
    const given = (key: unknown, v: number) => ({ type: 'Feature', geometry: null, properties: { id: key, v } });
    const { db, calls } = fakeDb([{ name: 'roads', type: 'roads', columns }], { roads: zoneRows([101, 102, 103], ['primary', 'primary', 5]) });
    await createDataAdapter().resolveSource(db, {
        type: 'update', dataRef: 'roads', strategy: 'update', idColumn: 'properties.id',
        geojsonObject: { type: 'FeatureCollection', features: [given('primary', 1), given('5', 2), given('motorway', 3)] },
    } as DataSourceSpec);
    assert.deepEqual(calls[1], ['updateTable', {
        tableName: 'roads', strategy: 'update', idColumn: 'id',
        data: { type: 'FeatureCollection', features: [{ ...given('primary', 1), id: 101 }, { ...given('primary', 1), id: 102 }, { ...given('5', 2), id: 103 }] },
    }]);
});

test('a layer update whose keys match no row leaves autk-db alone, and one of rows without feature ids is refused', async () => {
    const update = (dataRef: string) => ({
        type: 'update', dataRef, strategy: 'update', idColumn: 'properties.id',
        geojsonObject: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null, properties: { id: 7 } }] },
    } as DataSourceSpec);
    const unmatched = fakeDb([{ name: 'zones', type: 'polygons', columns: geojsonColumns }], { zones: zoneRows(zoneIds) });
    await createDataAdapter().resolveSource(unmatched.db, update('zones'));
    assert.deepEqual(unmatched.calls, [['getLayer', 'zones']]);
    const anonymous = fakeDb([{ name: 'zones', type: 'polygons', columns: geojsonColumns }], { zones: zoneRows([null, null, null, null], [7, 7, 7, 7]) });
    await assert.rejects(createDataAdapter().resolveSource(anonymous.db, update('zones')), { message: 'Update of "zones": its rows have no feature id to update them by.' });
    assert.deepEqual(anonymous.calls, [['getLayer', 'zones']]);
});

// autk-db 4.1.1 stages the rows of an update of a table without a geometry with DuckDB's read_json_auto, whose columns
// follow a row's keys in the order they come, then inserts them with `INSERT INTO <table> SELECT * FROM <staging>`, by
// position: a row given as { count: 25, zone: 2 } to a table of (zone, count) wrote 25 in zone and 2 in count.
const zoneCounts = { name: 'zones', columns: [{ name: 'zone', type: 'BIGINT' }, { name: 'count', type: 'BIGINT' }] };

test("an update of a table without a geometry hands autk-db each given row with its columns in the table's order", async () => {
    const jsonObject = [{ count: 25, zone: 2 }, { zone: 3, count: 30 }];
    const calls = await callsFor({ type: 'update', dataRef: 'zones', strategy: 'update', idColumn: 'zone', jsonObject }, [zoneCounts]);
    assert.deepEqual(calls, [['updateTable', { tableName: 'zones', data: [{ zone: 2, count: 25 }, { zone: 3, count: 30 }], strategy: 'update', idColumn: 'zone' }]]);
    // deepEqual compares no key order, so the order is compared apart.
    const { data } = calls[0][1] as { data: Array<Record<string, unknown>> };
    assert.deepEqual(data.map((row) => Object.keys(row)), [['zone', 'count'], ['zone', 'count']]);
    // replace makes the table of the given rows, by their keys' names, so they reach autk-db as they are given.
    const replaced = [{ count: 7, zone: 9, note: 'new' }];
    const [replace] = await callsFor({ type: 'update', dataRef: 'zones', strategy: 'replace', jsonObject: replaced }, [zoneCounts]);
    assert.equal((replace[1] as { data: unknown }).data, replaced);
});

test('refuses an update row of a table without a geometry that lacks a column of the table or has another, naming it, before autk-db runs', async () => {
    const refused = async (jsonObject: unknown[], message: string) => {
        const { db, calls } = fakeDb([zoneCounts]);
        await assert.rejects(createDataAdapter().resolveSource(db, { type: 'update', dataRef: 'zones', strategy: 'update', idColumn: 'zone', jsonObject } as DataSourceSpec), { message });
        assert.deepEqual(calls, []);
    };
    await refused([{ zone: 2, count: 25 }, { zone: 3 }], 'Update of "zones": jsonObject[1] has no "count"; autk-db writes each given row as a whole row of the table, so it gives every column: "zone", "count".');
    await refused([{ zone: 2, count: 25, extra: 1 }], 'Update of "zones": jsonObject[0] has "extra", which is not a column of the table: "zone", "count".');
});

// A layer of plain columns, such as a CSV or JSON table loaded with geometryColumns, or a sql source's table drawn as a
// layer whose query returns no properties, has no properties column and no feature id. autk-db 4.1.1 updates a row of
// a layer by setting its properties column, so the update strategy never changed such a table: a key
// `properties.<name>` found no feature id, a plain column failed to bind, and jsonObject is refused for a layer.
const plainColumns = 'on a layer, the update strategy sets the properties column of each row it matches, and this layer has none: it keeps its values in plain columns, as a CSV or JSON layer or a sql source\'s table of plain columns does. Use strategy \'replace\', with every row in geojsonObject.';

test('refuses the update strategy on a layer of plain columns, before autk-db runs, and hands autk-db its replace', async () => {
    const column = (name: string, type: string) => ({ name, type });
    const tables = [
        { name: 'noise', type: 'points', columns: [column('key', 'BIGINT'), column('level', 'BIGINT'), column('Latitude', 'DOUBLE'), column('Longitude', 'DOUBLE'), column('geometry', 'GEOMETRY')] },
        { name: 'noisiest', type: 'polygons', columns: [column('name', 'VARCHAR'), column('complaints', 'INTEGER'), column('geometry', 'GEOMETRY')] },
    ];
    const point = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { key: 2, level: 75 } }] };
    const updates: Array<[string, object]> = [
        ['noise', { idColumn: 'properties.key', geojsonObject: point }],
        ['noise', { idColumn: 'key', geojsonObject: point }],
        ['noise', { idColumn: 'key', jsonObject: [{ key: 2, level: 75 }] }],
        ['noisiest', { idColumn: 'properties.name', geojsonObject: point }],
    ];
    for (const [dataRef, fields] of updates) {
        const { db, calls } = fakeDb(tables);
        await assert.rejects(
            createDataAdapter().resolveSource(db, { type: 'update', dataRef, strategy: 'update', ...fields } as DataSourceSpec),
            { message: `Update of "${dataRef}": ${plainColumns}` },
            JSON.stringify(fields),
        );
        assert.deepEqual(calls, [], JSON.stringify(fields));
    }
    assert.deepEqual(await callsFor({ type: 'update', dataRef: 'noise', strategy: 'replace', geojsonObject: point }, tables), [
        ['updateTable', { tableName: 'noise', data: point, strategy: 'replace' }],
    ]);
});

// autk-db lists every column of a table it holds. A host's stand-in database may list none, and then the adapter cannot
// tell a table's columns: its rows go to autk-db as they are given, and the update strategy is not refused.
test('hands autk-db the update of a table listed without columns as it is given, neither ordered nor refused', async () => {
    const jsonObject = [{ total: 9, month: 'Feb' }];
    const [[, plain]] = await callsFor({ type: 'update', dataRef: 'sales', strategy: 'update', idColumn: 'month', jsonObject }, [{ name: 'sales' }]) as Array<[string, { data: unknown }]>;
    assert.equal(plain.data, jsonObject);
    const geojsonObject = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 3, geometry: { type: 'Point', coordinates: [0, 0] }, properties: { v: 1 } }] };
    assert.deepEqual(await callsFor({ type: 'update', dataRef: 'spots', strategy: 'update', idColumn: 'id', geojsonObject }, [{ name: 'spots', type: 'points' }]), [
        ['updateTable', { tableName: 'spots', data: geojsonObject, strategy: 'update', idColumn: 'id' }],
    ]);
});

// drop sources: a table dropped.
test('a drop source removes its table from autk-db, and from the cache the plots read first', async () => {
    const cache = new Map([['blocks', emptyCollection()], ['west/blocks', emptyCollection()]]);
    const { db, calls } = fakeDb([{ name: 'blocks', type: 'polygons' }]);
    await createDataAdapter(undefined, cache).resolveSource(db, { type: 'drop', dataRef: 'blocks' } as DataSourceSpec);
    assert.deepEqual(calls, [['removeLayer', 'blocks']]);
    assert.deepEqual([...cache.keys()], ['west/blocks']);
});

test('refuses to drop a table the workspace does not hold, naming the table and the workspace', async () => {
    const { db, calls } = fakeDb([{ name: 'blocks', type: 'polygons' }]);
    const adapter = createDataAdapter();
    await assert.rejects(
        adapter.resolveSource(db, { type: 'drop', dataRef: 'block' } as DataSourceSpec),
        { message: 'Drop of "block": the default workspace holds no table of that name.' },
    );
    await assert.rejects(
        adapter.resolveSource(db, { type: 'drop', dataRef: 'block', workspace: 'west' } as DataSourceSpec),
        { message: 'Drop of "block": the workspace "west" holds no table of that name.' },
    );
    assert.deepEqual(calls, [['setWorkspace', 'west']]);
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

test('a heatmap without groupBy hands autk-db the count its one band holds, which autk-db 4.1.1 built as 0 without it', async () => {
    const heatmap = { type: 'heatmap', outputTableName: 'heat', joinDataRef: 'noise', near: { distance: 500 }, grid: { rows: 4, columns: 4 } };
    const count = [{ column: '*', aggregateFn: 'count' }];
    for (const fields of [{}, { groupBy: [] }]) {
        assert.deepEqual(await callsFor({ ...heatmap, ...fields }), [
            ['buildHeatmap', { tableJoinName: 'noise', near: { distance: 500 }, outputTableName: 'heat', grid: { rows: 4, columns: 4 }, groupBy: count }],
        ]);
    }
});

// Sources after compute: the same calls, and the tables they write leave the compute adapter's caches.
test('a source after compute hands autk-db the fields it reads, never after', async () => {
    assert.deepEqual(await callsFor({ type: 'csv', outputTableName: 'c', csvFileUrl: 'rows.csv', after: 'compute' }),
        [['loadCsv', { outputTableName: 'c', csvFileUrl: 'rows.csv' }]]);
    assert.deepEqual(await callsFor({ type: 'drop', dataRef: 'c', after: 'compute' }, [{ name: 'c', type: 'points' }]), [['removeLayer', 'c']]);
});

test("each table a source writes leaves the compute adapter's caches, and the others stay", async () => {
    const written: Array<[unknown, string[]]> = [
        [{ type: 'join', dataRef: 'blocks', joinDataRef: 'pins', after: 'compute' }, ['blocks']],
        [{ type: 'sql', outputTableName: 's', query: 'SELECT 1', after: 'compute' }, ['s']],
        [{ type: 'update', dataRef: 'blocks', strategy: 'replace', jsonObject: [{ a: 1 }] }, ['blocks']],
        [{ type: 'drop', dataRef: 'blocks' }, ['blocks']],
        [{ type: 'heatmap', outputTableName: 'h', joinDataRef: 'pins', near: { distance: 1 }, grid: { rows: 1, columns: 1 } }, ['h']],
        [{ ...osm, outputTableName: 'box', autoLoadLayers: { layers: ['roads', 'buildings'] }, tagSets }, ['box_roads', 'box_buildings', 'box_cafes_points', 'box_paths_polylines']],
        [{ type: 'join', dataRef: 'blocks', joinDataRef: 'pins', workspace: 'west' }, ['west/blocks']],
    ];
    const names = ['blocks', 'pins', 's', 'h', 'box_roads', 'box_buildings', 'box_cafes_points', 'box_paths_polylines', 'west/blocks'];
    for (const [source, gone] of written) {
        const computeCache = new Map(names.map((name) => [name, emptyCollection()]));
        const computeTypes = new Map(names.map((name) => [name, 'polygons' as const]));
        const { db } = fakeDb([{ name: 'blocks', type: 'polygons' }, { name: 'pins', type: 'points' }]);
        (db as unknown as Record<string, unknown>).spatialQuery = async () => {};
        await createDataAdapter(undefined, undefined, computeCache, computeTypes).resolveSource(db, source as DataSourceSpec);
        const kept = names.filter((name) => !gone.includes(name));
        assert.deepEqual([...computeCache.keys()], kept, JSON.stringify(source));
        assert.deepEqual([...computeTypes.keys()], kept, JSON.stringify(source));
    }
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
