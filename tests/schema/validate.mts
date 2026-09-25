// Validates every gallery spec against the generated JSON Schema, and checks that
// the schema refuses documents the runtime cannot draw. Run after `make build`:
//   npm run test:schema
import { Ajv } from 'ajv';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(root, 'adapters/autk/build/autk-grammar-schema.json'), 'utf8'));
const validate = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(schema);

let failures = 0;
function expect(name: string, doc: unknown, valid: boolean) {
    const ok = validate(doc);
    if (ok !== valid) {
        failures++;
        console.error(`FAIL ${name}: expected ${valid ? 'valid' : 'invalid'}`);
        if (!ok) console.error(JSON.stringify(validate.errors?.slice(0, 5), null, 2));
    }
}

const examplesDir = join(root, 'gallery/src/examples');
const modules = readdirSync(examplesDir).filter(f => f.endsWith('.ts'));
let checked = 0;
for (const file of modules) {
    const mod = await import(pathToFileURL(join(examplesDir, file)).href);
    if (!('spec' in mod)) continue;
    expect(`gallery/${file}`, JSON.parse(JSON.stringify(mod.spec)), true);
    checked++;
}

const osm = { type: 'osm', outputTableName: 't', queryArea: { geocodeArea: 'Boston', areas: ['Back Bay'] } };
const csv = { type: 'csv', outputTableName: 'c', csvFileUrl: 'rows.csv' };
const point = { type: 'Point', coordinates: [0, 0] };
const plot = { dataRef: 't', axis: ['a', 'b'] };
const layers = { layerRefs: [{ dataRef: 't' }] };
const compute = { dataRef: 't', attributes: { h: 'height' }, outputColumnName: 'out', wglsFunction: 'return h;' };

// Forms the runtime accepts.
expect('extra keys stay open', { data: [osm], map: layers, initialView: { zoom: 3 } }, true);
expect('$schema declaration', { $schema: schema.$id, map: layers }, true);
expect('wglsFunction as lines', { compute: [{ ...compute, wglsFunction: ['let x = h;', 'return x;'] }] }, true);
expect('fromFeature uniform', {
    compute: [{ ...compute, uniforms: { sunAz: { fromFeature: { layer: 'sun', path: 'properties.az', iterate: 'batched', required: true }, default: 0 } } }],
}, true);
expect('fromFeature matrix', {
    compute: [{ ...compute, uniformMatrices: { outline: { fromFeature: { layer: 'b', path: 'geometry.coordinates.0', iterate: 'all' }, cols: 2 } } }],
}, true);
expect('outputColumns instead of outputColumnName', { compute: [{ ...compute, outputColumnName: undefined, outputColumns: ['a', 'b'] }] }, true);
expect('osm layers without dropOsmTable', { data: [{ ...osm, autoLoadLayers: { layers: ['roads'] } }] }, true);
expect('csv geometryColumns true', { data: [{ ...csv, geometryColumns: true }] }, true);
expect('csv geometryColumns wkt', { data: [{ ...csv, geometryColumns: { wktColumnName: 'geom' } }] }, true);
expect('json inline with lat/long', { data: [{ type: 'json', outputTableName: 'j', jsonObject: [{}], geometryColumns: { latColumnName: 'y', longColumnName: 'x' } }] }, true);
expect('geojson with null geometry and no properties', {
    data: [{ type: 'geojson', outputTableName: 'g', geojsonObject: { type: 'FeatureCollection', features: [
        { type: 'Feature', geometry: point, properties: {} },
        { type: 'Feature', geometry: null, properties: null },
        { type: 'Feature', geometry: point },
    ] } }],
}, true);
expect('geojson with url and object', { data: [{ type: 'geojson', outputTableName: 'g', geojsonFileUrl: 'g.json', geojsonObject: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: point }] } }] }, true);
expect('color scheme autk-core added', { map: { layerRefs: [{ dataRef: 't', colorMapInterpolator: 'interpolateYlGnBu' }] } }, true);
expect('bar without transform', { plot: { ...plot, mark: 'bar' } }, true);
expect('bar with binning-1d', { plot: { ...plot, mark: 'bar', transform: { preset: 'binning-1d' } } }, true);
expect('linechart with reduce-series', { plot: { ...plot, mark: 'linechart', transform: { preset: 'reduce-series', options: { reducer: 'sum' } } } }, true);
expect('line with binning-events', { plot: { ...plot, mark: 'line', transform: { preset: 'binning-events' } } }, true);
expect('table with sort', { plot: { ...plot, mark: 'table', transform: { preset: 'sort' } } }, true);
expect('heatmatrix with binning-2d', { plot: { ...plot, mark: 'heatmatrix', transform: { preset: 'binning-2d' } } }, true);
expect('parallel coordinates with any preset', { plot: { ...plot, mark: 'parallel-coordinates', transform: { preset: 'binning-1d' } } }, true);

// Documents the runtime cannot draw.
expect('unknown data type', { data: [{ ...osm, type: 'shapefile' }] }, false);
expect('heatmap without grid', { data: [{ type: 'heatmap', outputTableName: 'h', tableJoinName: 't', near: { distance: 5 } }] }, false);
expect('heatmap is not a csv', { data: [{ type: 'heatmap', outputTableName: 'x' }] }, false);
expect('osm without queryArea', { data: [{ type: 'osm', outputTableName: 't' }] }, false);
expect('join without tableJoinName', { data: [{ type: 'join', tableRootName: 't' }] }, false);
expect('map without layerRefs', { map: {} }, false);
expect('layer without dataRef', { map: { layerRefs: [{ opacity: 1 }] } }, false);
expect('unknown color scheme', { map: { layerRefs: [{ dataRef: 't', colorMapInterpolator: 'rainbow' }] } }, false);
expect('plot with unknown mark', { plot: { dataRef: 't', mark: 'pie', axis: ['a'] } }, false);
expect('plot with empty axis', { plot: { dataRef: 't', mark: 'bar', axis: [] } }, false);
expect('plot without axis', { plot: { dataRef: 't', mark: 'bar' } }, false);
expect('compute without an output', { compute: [{ dataRef: 't', attributes: {}, wglsFunction: 'return 1;' }] }, false);
expect('compute without wglsFunction', { compute: [{ dataRef: 't', attributes: {}, outputColumnName: 'o' }] }, false);
expect('compute with empty outputColumns', { compute: [{ ...compute, outputColumns: [] }] }, false);
expect('data source without type', { data: [{ outputTableName: 't', csvFileUrl: 'x.csv' }] }, false);
expect('csv without a source', { data: [{ type: 'csv', outputTableName: 'c' }] }, false);
expect('csv with both sources', { data: [{ ...csv, csvObject: [['a']] }] }, false);
expect('json without a source', { data: [{ type: 'json', outputTableName: 'j' }] }, false);
expect('geojson without a source', { data: [{ type: 'geojson', outputTableName: 'g' }] }, false);
expect('geojson with no features', { data: [{ type: 'geojson', outputTableName: 'g', geojsonObject: { type: 'FeatureCollection', features: [] } }] }, false);
expect('linechart without transform', { plot: { ...plot, mark: 'linechart' } }, false);
expect('linechart with binning-1d', { plot: { ...plot, mark: 'linechart', transform: { preset: 'binning-1d' } } }, false);
expect('heatmatrix with sort', { plot: { ...plot, mark: 'heatmatrix', transform: { preset: 'sort' } } }, false);
expect('scatter with one axis', { plot: { dataRef: 't', mark: 'scatter', axis: ['a'] } }, false);
expect('table with binning', { plot: { ...plot, mark: 'table', transform: { preset: 'binning-1d' } } }, false);
expect('bar with sort', { plot: { ...plot, mark: 'bar', transform: { preset: 'sort' } } }, false);
expect('unknown transform preset', { plot: { ...plot, mark: 'scatter', transform: { preset: 'smooth' } } }, false);

if (checked === 0) {
    failures++;
    console.error('FAIL no gallery specs were found');
}
console.log(`${checked} gallery specs checked, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
