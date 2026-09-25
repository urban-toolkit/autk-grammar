// Validates every gallery spec against the generated JSON Schema, and checks that
// the schema refuses documents the runtime cannot draw. Run after `make build`:
//   npm run test:schema
import Ajv from 'ajv';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(root, 'adapters/autk/build/autk-grammar-schema.json'), 'utf8'));
const validate = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);

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

if (checked === 0) {
    failures++;
    console.error('FAIL no gallery specs were found');
}
console.log(`${checked} gallery specs checked, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
