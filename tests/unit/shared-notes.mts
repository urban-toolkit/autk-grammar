// Unit tests for the notes a data adapter keeps on each GeoJSON source it puts in its cache: the CRS of the source's
// coordinates, which a compute pass checks before it reads a `fromFeature` table from that cache. The package's main
// entry and its `./data` entry are two bundles, each with its own copy of the code that keeps the notes. These tests
// load both built entries, as a host does that loads a spec's tables with `./data` and runs its passes with the main
// entry, and record the parameters a pass hands autk-compute, which they answer without a GPU. Run after `make build`:
//   npm run test:unit
import assert from 'node:assert/strict';
import { DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';
import type { AutkDb } from '@urban-toolkit/autk-db';
import { AutkComputeEngine } from '@urban-toolkit/autk-compute';
import type { GpgpuPipelineParams } from '@urban-toolkit/autk-compute';
import type { Feature, FeatureCollection, Geometry, Polygon } from 'geojson';
import * as dataEntry from '@urban-toolkit/autk-grammar/data';
import * as mainEntry from '@urban-toolkit/autk-grammar';
import type { DataSourceSpec, GpgpuComputeSpec } from '@urban-toolkit/autk-grammar';

/** The parameters of each dispatch a pass asked autk-compute for, answered with the pass's own table. */
const dispatched: GpgpuPipelineParams[] = [];
AutkComputeEngine.prototype.gpgpuPipeline = async function (params: GpgpuPipelineParams) {
    dispatched.push(params);
    return params.collection;
};

// Three building parts, each 20 m wide, and four spots south of them, in World Mercator meters, the workspace's CRS.
const [x0, y0] = [-8235000, 4946000];
const square = (x: number, y: number, size: number): Polygon =>
    ({ type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });
const feature = (properties: Record<string, unknown>, geometry: Geometry): Feature => ({ type: 'Feature', properties, geometry });
const parts: FeatureCollection = {
    type: 'FeatureCollection',
    features: [0, 1, 2].map((i) => feature({ height: 10 + i }, square(x0 + i * 50, y0, 20))),
};
const spots: FeatureCollection = {
    type: 'FeatureCollection',
    features: [0, 1, 2, 3].map((i) => feature({ w: 1 }, { type: 'Point', coordinates: [x0 + i * 40, y0 - 100] })),
};
const sources: DataSourceSpec[] = [
    { type: 'geojson', outputTableName: 'parts', coordinateFormat: 'EPSG:3395', layerType: 'buildings', geojsonObject: parts },
    { type: 'geojson', outputTableName: 'spots', coordinateFormat: 'EPSG:3395', geojsonObject: spots },
] as DataSourceSpec[];
// The pass packs each part's outline as its box: [xmin,ymin, xmax,ymin, xmax,ymax, xmin,ymax].
const pass: GpgpuComputeSpec = {
    dataRef: 'spots',
    attributes: { w: 'w' },
    uniformMatrices: { o: { fromFeature: { layer: 'parts', path: 'geometry.coordinates.0', iterate: 'batched' }, cols: 2 } },
    outputColumnName: 'width',
    wgslFunction: 'return w;',
};
const outlines = [0, 1, 2].flatMap((i) => {
    const [xmin, xmax] = [x0 + i * 50, x0 + i * 50 + 20];
    return [xmin, y0, xmax, y0, xmax, y0 + 20, xmin, y0 + 20];
});

/**
 * A fake AutkDb in World Mercator that loads GeoJSON sources and exports them as autk-db 4.1.1 does: a buildings table
 * with each feature in its building model, the geometry inside a GeometryCollection, where `geometry.coordinates.0`
 * finds no outline.
 */
function fakeDb(): AutkDb {
    let current = DEFAULT_WORKSPACE_NAME;
    const tables = new Map<string, { type: string; collection: FeatureCollection }>();
    const db = {
        getCurrentWorkspace: () => current,
        setWorkspace: async (name: string) => { current = name; },
        getWorkspaceConfiguration: () => ({ coordinateFormat: 'EPSG:3395', precisionGrid: 0.01 }),
        loadGeojson: async ({ outputTableName, geojsonObject, layerType }: { outputTableName: string; geojsonObject: FeatureCollection; layerType?: string }) => {
            tables.set(outputTableName, { type: layerType ?? 'points', collection: geojsonObject });
        },
        getBoundingBoxFromLayer: async () => ({ minLon: x0 - 100, minLat: y0 - 200, maxLon: x0 + 200, maxLat: y0 + 100 }),
        getTablesMetadata: () => [...tables].map(([name, { type }]) => ({ name, type, source: 'geojson', columns: [] })),
        getLayer: async (name: string): Promise<FeatureCollection> => {
            const table = tables.get(name);
            if (!table) throw new Error(`no table ${name}`);
            if (table.type !== 'buildings') return table.collection;
            return {
                type: 'FeatureCollection',
                features: table.collection.features.map((part) => feature(
                    { ...part.properties, parts: [{ geometryIndex: 0 }] },
                    { type: 'GeometryCollection', geometries: [part.geometry] },
                )),
            };
        },
    };
    return db as unknown as AutkDb;
}

/** Loads the sources with `createDataAdapter` from `data`, runs the pass with the main entry's compute adapter, and gives its dispatch. */
async function runPass(data: { createDataAdapter: typeof dataEntry.createDataAdapter }): Promise<GpgpuPipelineParams> {
    dispatched.length = 0;
    const cache = new Map<string, FeatureCollection>();
    const dataAdapter = data.createDataAdapter(undefined, cache);
    let db: AutkDb = fakeDb();
    for (const source of sources) db = await dataAdapter.resolveSource(db, source);
    await mainEntry.createComputeAdapter(new Map(), new Map(), cache).resolveCompute(db, pass);
    assert.equal(dispatched.length, 1);
    return dispatched[0];
}

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("a pass of the main entry reads each part's outline as the ./data entry's data adapter loaded it", async () => {
    // The ./data bundle kept its notes in a map of its own, so the main entry's pass found none and read the building
    // model autk-db exports: three empty boxes.
    const { uniforms, uniformArrays } = await runPass(dataEntry);
    assert.equal(uniforms?.num_features, 3);
    assert.deepEqual(uniformArrays?.o, outlines);
});

test("and as the main entry's own data adapter loaded it", async () => {
    const { uniforms, uniformArrays } = await runPass(mainEntry);
    assert.equal(uniforms?.num_features, 3);
    assert.deepEqual(uniformArrays?.o, outlines);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
