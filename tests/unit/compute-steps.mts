// Unit tests for `createComputeSteps`: a run's workspaces, sources and compute passes on an autk-db database the host
// owns, one call at a time, and each pass's result as the grammar holds it (`computed`). A fake autk-db records every
// call the steps make of it, and holds what they write; the browser tests run the steps on autk-db itself. The last case
// reads the built main entry, so run after `make build`:
//   npm run test:unit
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';
import type { AutkDb } from '@urban-toolkit/autk-db';
import type { FeatureCollection, Polygon } from 'geojson';
import type { ClustersComputeSpec, DataSourceSpec } from '@urban-toolkit/the-urban-grammar';
import { createComputeSteps } from '../../adapters/autk/src/compute-steps.ts';

/** A call the steps made of the database: the method's name, then its arguments. */
type Call = [method: string, ...args: unknown[]];
type FakeTable = { name: string; type?: string; columns?: Array<{ name: string; type: string }> };

const square = (x: number): Polygon => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]]] });
/** Three squares: the first two share an edge, so a clusters pass puts them in cluster 0, and the third in cluster 1. */
const squares: FeatureCollection = {
    type: 'FeatureCollection',
    features: [0, 10, 100].map((x, i) => ({ type: 'Feature', id: `autk-feature-${i}`, properties: { i }, geometry: square(x) })),
};
const geojsonColumns = ['id', 'geojson_id', 'geometry', 'properties'].map((name) => ({ name, type: name === 'geometry' ? 'GEOMETRY' : 'JSON' }));
const squaresTable: FakeTable = { name: 'squares', type: 'polygons', columns: geojsonColumns };

/**
 * A fake AutkDb holding `tables`, whose exports are `layers`, that records every call. It holds what the steps write: a
 * table a query creates, the rows `updateTable` writes, which a count query counts, and no table a drop removes.
 */
function fakeDb(tables: FakeTable[], layers: Record<string, FeatureCollection> = {}): { db: AutkDb; calls: Call[] } {
    const calls: Call[] = [];
    const held = [...tables];
    const rows = new Map<string, number>(Object.entries(layers).map(([name, layer]) => [name, layer.features.length]));
    let workspace = DEFAULT_WORKSPACE_NAME;
    const db = {
        getCurrentWorkspace: () => workspace,
        setWorkspace: async (name: string, ...rest: unknown[]) => { calls.push(['setWorkspace', name, ...rest]); workspace = name; },
        getWorkspaceConfiguration: () => ({ coordinateFormat: 'EPSG:3395' }),
        getTablesMetadata: () => held.map((table) => ({ columns: [], ...table })),
        getLayer: async (name: string) => { calls.push(['getLayer', name]); return layers[name] ?? { type: 'FeatureCollection', features: [] }; },
        loadCsv: async (params: unknown) => { calls.push(['loadCsv', params]); },
        spatialQuery: async (params: unknown) => { calls.push(['spatialQuery', params]); },
        removeLayer: async (name: string) => {
            calls.push(['removeLayer', name]);
            held.splice(held.findIndex((table) => table.name === name), 1);
        },
        updateTable: async (params: { tableName: string; data: FeatureCollection }) => {
            calls.push(['updateTable', params]);
            rows.set(params.tableName, params.data.features.length);
        },
        rawQuery: async (params: { query: string; output: { type: string; tableName?: string; tableType?: string } }) => {
            calls.push(['rawQuery', params]);
            const counted = /^SELECT count\(\*\) AS n FROM "(.+)"$/.exec(params.query);
            if (counted) return [{ n: BigInt(rows.get(counted[1]) ?? 0) }];
            if (params.output.type === 'CREATE_TABLE' && params.output.tableName)
                held.push({ name: params.output.tableName, type: params.output.tableType, columns: geojsonColumns });
            return [];
        },
    };
    return { db: db as unknown as AutkDb, calls };
}

const clusters = (fields: Partial<ClustersComputeSpec> = {}): ClustersComputeSpec =>
    ({ type: 'clusters', dataRef: 'squares', outputColumnName: 'block', ...fields });
const csv = (name: string): DataSourceSpec => ({ type: 'csv', outputTableName: name, csvFileUrl: `${name}.csv` });
/** The value of the compute column `column` of each feature of a table `computed` gives. */
const column = (table: { collection: FeatureCollection } | undefined, name: string) =>
    table?.collection.features.map((feature) => feature.properties?.compute?.[name]);

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("runs each step on the host's database and returns it: workspaces, a source, a pass written back, a source after compute", async () => {
    const { db, calls } = fakeDb([squaresTable], { squares });
    const steps = createComputeSteps();
    assert.equal(await steps.resolveWorkspaces(db, [{ coordinateFormat: 'EPSG:3857', precisionGrid: 1 }]), db);
    assert.equal(await steps.resolveSource(db, csv('sales')), db);
    assert.equal(await steps.resolveCompute(db, clusters({ writeBack: true })), db);
    assert.equal(await steps.resolveSource(db, { type: 'sql', outputTableName: 'sizes', query: 'SELECT 1 AS n', after: 'compute' }), db);
    // Every call reached the host's database, in the order of the steps: no step made a database of its own.
    assert.deepEqual(calls.map(([method]) => method), ['setWorkspace', 'loadCsv', 'getLayer', 'updateTable', 'rawQuery', 'rawQuery']);
    assert.deepEqual(calls[0], ['setWorkspace', DEFAULT_WORKSPACE_NAME, { coordinateFormat: 'EPSG:3857', precisionGrid: 1 }]);
    assert.deepEqual(calls[1], ['loadCsv', { outputTableName: 'sales', csvFileUrl: 'sales.csv' }]);
    // The pass kept in autk-db, in place, the very collection computed gives.
    const written = calls[3][1] as { data: FeatureCollection };
    assert.deepEqual(calls[3], ['updateTable', { tableName: 'squares', data: written.data, strategy: 'update', idColumn: 'geojson_id' }]);
    assert.equal(written.data, steps.computed('squares')?.collection);
    assert.deepEqual(column({ collection: written.data }, 'block'), [0, 0, 1]);
    assert.deepEqual(calls[5], ['rawQuery', { query: 'SELECT 1 AS n', output: { type: 'CREATE_TABLE', tableName: 'sizes', source: 'user' } }]);
});

test("computed gives a pass's result, with the layer type of a table it wrote under its own name, and a later pass reads it there", async () => {
    const { db, calls } = fakeDb([squaresTable], { squares });
    const steps = createComputeSteps();
    assert.equal(steps.computed('blocks'), undefined);
    await steps.resolveCompute(db, clusters({ outputTableName: 'blocks', layerType: 'polygons' }));
    const blocks = steps.computed('blocks');
    assert.deepEqual(column(blocks, 'block'), [0, 0, 1]);
    assert.equal(blocks?.layerType, 'polygons');
    // The pass only read the squares, so no result of theirs is held, and autk-db's table is the one maps draw.
    assert.equal(steps.computed('squares'), undefined);

    // A later pass reads blocks from the first one's result: autk-db holds no table of that name.
    await steps.resolveCompute(db, clusters({ dataRef: 'blocks', outputColumnName: 'again' }));
    assert.equal(calls.filter(([method, name]) => method === 'getLayer' && name === 'blocks').length, 0);
    assert.deepEqual(column(steps.computed('blocks'), 'again'), [0, 0, 1]);
    assert.deepEqual(column(steps.computed('blocks'), 'block'), [0, 0, 1]);

    // A pass in place keeps its result with no layer type of its own: a map draws it as autk-db's table.
    await steps.resolveCompute(db, clusters());
    const inPlace = steps.computed('squares');
    assert.deepEqual(column(inPlace, 'block'), [0, 0, 1]);
    assert.equal(inPlace && 'layerType' in inPlace, false);
});

test('a source that writes a table takes it out of computed, and leaves the tables it does not write', async () => {
    const { db, calls } = fakeDb([squaresTable], { squares });
    const steps = createComputeSteps();
    await steps.resolveCompute(db, clusters({ writeBack: true }));
    await steps.resolveCompute(db, clusters({ outputTableName: 'blocks', layerType: 'polygons', writeBack: true }));
    assert.ok(steps.computed('squares'));
    assert.ok(steps.computed('blocks'));

    // A drop after compute of the table the second pass wrote back: autk-db held it, and holds it no longer.
    await steps.resolveSource(db, { type: 'drop', dataRef: 'blocks', after: 'compute' });
    assert.deepEqual(calls.at(-1), ['removeLayer', 'blocks']);
    assert.equal(steps.computed('blocks'), undefined);
    assert.deepEqual(column(steps.computed('squares'), 'block'), [0, 0, 1]);

    // A join after compute into the squares the first pass wrote back in place: autk-db's table is the one read now.
    await steps.resolveSource(db, { type: 'join', dataRef: 'squares', joinDataRef: 'pins', after: 'compute' });
    assert.ok(calls.some(([method]) => method === 'spatialQuery'));
    assert.equal(steps.computed('squares'), undefined);
});

test("computed finds a table by its workspace, as tableKey names it, and a pass runs in its workspace", async () => {
    const { db, calls } = fakeDb([squaresTable], { squares });
    const steps = createComputeSteps();
    await steps.resolveCompute(db, clusters({ outputTableName: 'blocks', layerType: 'polygons', workspace: 'west' }));
    assert.deepEqual(calls[0], ['setWorkspace', 'west']);
    assert.deepEqual(column(steps.computed('blocks', 'west'), 'block'), [0, 0, 1]);
    assert.equal(steps.computed('blocks'), undefined);
    assert.equal(steps.computed('blocks', 'east'), undefined);
    // The default workspace, by its name or by none.
    await steps.resolveCompute(db, clusters());
    assert.ok(steps.computed('squares'));
    assert.equal(steps.computed('squares', DEFAULT_WORKSPACE_NAME)?.collection, steps.computed('squares')?.collection);
});

test("each step refuses a call without the host's database, before anything runs", async () => {
    const steps = createComputeSteps();
    const none = undefined as unknown as AutkDb;
    const refusal = (step: string) => ({ message: `${step}: the steps run on an autk-db database the host owns, and none was given.` });
    await assert.rejects(steps.resolveWorkspaces(none, [{ coordinateFormat: 'EPSG:3857', precisionGrid: 1 }]), refusal('resolveWorkspaces'));
    await assert.rejects(steps.resolveSource(none, { type: 'geojson', outputTableName: 'squares', geojsonObject: squares }), refusal('resolveSource'));
    await assert.rejects(steps.resolveCompute(none, clusters()), refusal('resolveCompute'));
    // Nothing ran: no pass left a result.
    assert.equal(steps.computed('squares'), undefined);
});

test("the main entry's builds export createComputeSteps, whose steps run as the source's, and ./data does not", async () => {
    const require = createRequire(import.meta.url);
    const builds: Array<[string, { createComputeSteps?: typeof createComputeSteps }]> = [
        ['ES module', await import('@urban-toolkit/autk-grammar')],
        ['CommonJS module', require('@urban-toolkit/autk-grammar')],
    ];
    for (const [build, entry] of builds) {
        assert.equal(typeof entry.createComputeSteps, 'function', build);
        const { db } = fakeDb([squaresTable], { squares });
        const steps = entry.createComputeSteps!();
        await steps.resolveCompute(db, clusters({ outputTableName: 'blocks', layerType: 'polygons' }));
        assert.deepEqual(column(steps.computed('blocks'), 'block'), [0, 0, 1], build);
        assert.equal(steps.computed('blocks')?.layerType, 'polygons', build);
    }
    // The data entry keeps autk-db as its only import (tests/unit/data-entry.mts): the steps run passes, on autk-compute.
    for (const data of [await import('@urban-toolkit/autk-grammar/data'), require('@urban-toolkit/autk-grammar/data')])
        assert.equal((data as Record<string, unknown>).createComputeSteps, undefined);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
