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
const compute = { dataRef: 't', attributes: { h: 'height' }, outputColumnName: 'out', wgslFunction: 'return h;' };

// Forms the runtime accepts.
expect('extra keys stay open', { data: [osm], map: layers, initialView: { zoom: 3 } }, true);
expect('$schema declaration', { $schema: schema.$id, map: layers }, true);
expect('wgslFunction as lines', { compute: [{ ...compute, wgslFunction: ['let x = h;', 'return x;'] }] }, true);
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
expect('map camera', { map: { ...layers, camera: { zoom: 14, pitch: 60, bearing: 90 } } }, true);
expect('map camera with one field', { map: { ...layers, camera: { pitch: 45 } } }, true);
expect('layout grid', { map: layers, layout: { type: 'grid', columns: 3, gap: 8 } }, true);
expect('layout without fields', { map: layers, layout: {} }, true);
expect('ids and a link', { map: { ...layers, id: 'm' }, plot: { ...plot, mark: 'scatter', id: 'p' }, links: [{ source: 'p', target: 'm' }] }, true);
expect('link naming a layer', { map: { ...layers, id: 'm' }, plot: { ...plot, mark: 'scatter', id: 'p' }, links: [{ source: 'p', target: 'm', layer: 'Roads' }] }, true);
expect('no links', { map: layers, links: [] }, true);
expect('layer selectFields', { map: { layerRefs: [{ dataRef: 't', isPick: true, selectFields: ['id'] }] } }, true);
expect('scatter selectFields', { plot: { ...plot, mark: 'scatter', events: ['click'], selectFields: ['city', 'id'] } }, true);
expect('bar selectFields', { plot: { ...plot, mark: 'bar', events: ['brushX'], selectFields: ['id'] } }, true);
expect('layer title, color, outline and width', { map: { layerRefs: [{ dataRef: 't', title: 'Trees', color: '#1f77b4', stroke: '#D62728', width: 2.5 }] } }, true);
expect('layer without an outline', { map: { layerRefs: [{ dataRef: 't', stroke: false }] } }, true);
expect('raster scale centered and reversed', { map: { layerRefs: [{ dataRef: 'r', colorMapInterpolator: 'interpolateRdBu', colorMapCenter: -1.5, colorMapReverse: true }] } }, true);
expect('raster transfer function', { map: { layerRefs: [{ dataRef: 'r', transferFunction: { mode: 'linear', opacityMin: 0, opacityMax: 1, gamma: 2, zeroCenter: 5 } }] } }, true);
expect('raster cells opaque', { map: { layerRefs: [{ dataRef: 'r', transferFunction: { opacityMin: 1, opacityMax: 1 } }] } }, true);
expect('layer color range', { map: { layerRefs: [{ dataRef: 't', getFnv: 'v', colorMapRange: [0, 11] }] } }, true);
expect('raster color range centered and reversed', {
    map: { layerRefs: [{ dataRef: 'r', colorMapInterpolator: 'interpolateRdBu', colorMapRange: [-2.5, 4], colorMapCenter: 0, colorMapReverse: true }] },
}, true);
const box = [-87.66415, 41.858, -87.61232, 41.89966];
const osmIn = (queryArea: unknown) => ({ data: [{ ...osm, queryArea }] });
expect('osm with a bbox', osmIn({ bbox: box }), true);
expect('osm with a bbox and a pbf', { data: [{ ...osm, pbfFileUrl: 'downtown.osm.pbf', queryArea: { bbox: box } }] }, true);

// Documents the runtime cannot draw.
expect('unknown data type', { data: [{ ...osm, type: 'shapefile' }] }, false);
expect('heatmap without grid', { data: [{ type: 'heatmap', outputTableName: 'h', joinDataRef: 't', near: { distance: 5 } }] }, false);
expect('heatmap is not a csv', { data: [{ type: 'heatmap', outputTableName: 'x' }] }, false);
expect('osm without queryArea', { data: [{ type: 'osm', outputTableName: 't' }] }, false);
expect('join without joinDataRef', { data: [{ type: 'join', dataRef: 't' }] }, false);
expect('map without layerRefs', { map: {} }, false);
expect('layer without dataRef', { map: { layerRefs: [{ opacity: 1 }] } }, false);
expect('unknown color scheme', { map: { layerRefs: [{ dataRef: 't', colorMapInterpolator: 'rainbow' }] } }, false);
expect('plot with unknown mark', { plot: { dataRef: 't', mark: 'pie', axis: ['a'] } }, false);
expect('plot with empty axis', { plot: { dataRef: 't', mark: 'bar', axis: [] } }, false);
expect('plot without axis', { plot: { dataRef: 't', mark: 'bar' } }, false);
expect('compute without an output', { compute: [{ dataRef: 't', attributes: {}, wgslFunction: 'return 1;' }] }, false);
expect('compute without wgslFunction', { compute: [{ dataRef: 't', attributes: {}, outputColumnName: 'o' }] }, false);
expect('compute with empty outputColumns', { compute: [{ ...compute, outputColumns: [] }] }, false);
expect('data source without type', { data: [{ outputTableName: 't', csvFileUrl: 'x.csv' }] }, false);
expect('csv without a source', { data: [{ type: 'csv', outputTableName: 'c' }] }, false);
expect('csv with both sources', { data: [{ ...csv, csvObject: [['a']] }] }, false);
expect('json without a source', { data: [{ type: 'json', outputTableName: 'j' }] }, false);
expect('geotiff', { data: [{ type: 'geotiff', outputTableName: 'r', geotiffFileUrl: 'r.tif', coordinateFormat: 'EPSG:3857', maxRasterCells: 5000, resampleMethod: 'nearest' }] }, true);
expect('geotiff without a url', { data: [{ type: 'geotiff', outputTableName: 'r' }] }, false);
expect('geotiff with a bad resample method', { data: [{ type: 'geotiff', outputTableName: 'r', geotiffFileUrl: 'r.tif', resampleMethod: 'cubic' }] }, false);
expect('geojson with a layer type', { data: [{ type: 'geojson', outputTableName: 'g', geojsonFileUrl: 'g.json', layerType: 'polylines' }] }, true);
expect('geojson with a bad layer type', { data: [{ type: 'geojson', outputTableName: 'g', geojsonFileUrl: 'g.json', layerType: 'rivers' }] }, false);
const gpgpu = { dataRef: 'g', attributes: { x: 'a' }, outputColumnName: 'r', wgslFunction: 'return x;' };
const render = { type: 'render', outputTableName: 'vis', layers: [{ id: 'b', dataRef: 'b', type: 'buildings' }], viewpoints: { dataRef: 'b', strategy: { type: 'building-windows', floors: 3 }, sampling: { directions: 8 } }, aggregation: { type: 'classes', includeBackground: true }, camera: { fov: 90, clip: { near: 1, far: 500 } }, tileSize: 64 };
expect('gpgpu pass into a new table', { compute: [{ ...gpgpu, type: 'gpgpu', outputTableName: 'g2', layerType: 'polygons' }] }, true);
expect('render pass', { compute: [render] }, true);
expect('render pass without outputTableName', { compute: [(({ outputTableName, ...rest }) => rest)(render)] }, false);
expect('render pass without layers', { compute: [{ ...render, layers: [] }] }, false);
expect('render pass with a tile size that is not a multiple of 8', { compute: [{ ...render, tileSize: 30 }] }, false);
expect('render pass with a bad aggregation', { compute: [{ ...render, aggregation: { type: 'sum' } }] }, false);
const heat = { type: 'heatmap', outputTableName: 'h', joinDataRef: 'n', near: { distance: 500 }, grid: { rows: 10, columns: 10 } };
expect('heatmap with useCentroid', { data: [{ ...heat, near: { distance: 500, useCentroid: false } }] }, true);
expect('heatmap with a non-boolean useCentroid', { data: [{ ...heat, near: { distance: 500, useCentroid: 'no' } }] }, false);
expect('workspaces on sources, a map, a plot and a compute pass', {
    data: [{ type: 'geojson', outputTableName: 'g', geojsonFileUrl: 'g.json', workspace: 'west' }, { type: 'join', dataRef: 'g', joinDataRef: 'g', workspace: 'west' }],
    compute: [{ dataRef: 'g', attributes: { x: 'a' }, outputColumnName: 'r', wgslFunction: 'return x;', workspace: 'west' }],
    map: { workspace: 'west', layerRefs: [{ dataRef: 'g' }] },
    plot: { workspace: 'west', dataRef: 'g', mark: 'scatter', axis: ['a', 'b'] },
}, true);
expect('an empty workspace name', { data: [{ type: 'geojson', outputTableName: 'g', geojsonFileUrl: 'g.json', workspace: '' }] }, false);
expect('geojson without a source', { data: [{ type: 'geojson', outputTableName: 'g' }] }, false);
expect('geojson with no features', { data: [{ type: 'geojson', outputTableName: 'g', geojsonObject: { type: 'FeatureCollection', features: [] } }] }, false);
expect('linechart without transform', { plot: { ...plot, mark: 'linechart' } }, false);
expect('linechart with binning-1d', { plot: { ...plot, mark: 'linechart', transform: { preset: 'binning-1d' } } }, false);
expect('heatmatrix with sort', { plot: { ...plot, mark: 'heatmatrix', transform: { preset: 'sort' } } }, false);
expect('scatter with one axis', { plot: { dataRef: 't', mark: 'scatter', axis: ['a'] } }, false);
expect('table with binning', { plot: { ...plot, mark: 'table', transform: { preset: 'binning-1d' } } }, false);
expect('bar with sort', { plot: { ...plot, mark: 'bar', transform: { preset: 'sort' } } }, false);
expect('unknown transform preset', { plot: { ...plot, mark: 'scatter', transform: { preset: 'smooth' } } }, false);
// Keys the schema does not name are allowed, so each of these is valid unless selectFields is typed.
expect('layer selectFields as a string', { map: { layerRefs: [{ dataRef: 't', selectFields: 'id' }] } }, false);
expect('layer selectFields empty', { map: { layerRefs: [{ dataRef: 't', selectFields: [] }] } }, false);
expect('layer selectFields with a number', { map: { layerRefs: [{ dataRef: 't', selectFields: ['id', 3] }] } }, false);
for (const mark of ['scatter', 'bar']) {
    expect(`${mark} selectFields as a string`, { plot: { ...plot, mark, selectFields: 'id' } }, false);
    expect(`${mark} selectFields empty`, { plot: { ...plot, mark, selectFields: [] } }, false);
    expect(`${mark} selectFields with a number`, { plot: { ...plot, mark, selectFields: ['id', 3] } }, false);
}
// The same holds for the layer styling options.
const layer = (options: Record<string, unknown>) => ({ map: { layerRefs: [{ dataRef: 't', ...options }] } });
expect('layer title empty', layer({ title: '' }), false);
expect('layer title as a number', layer({ title: 3 }), false);
expect('layer color by name', layer({ color: 'red' }), false);
expect('layer color as short hex', layer({ color: '#f00' }), false);
expect('layer color without #', layer({ color: '1f77b4' }), false);
expect('layer stroke true', layer({ stroke: true }), false);
expect('layer stroke by name', layer({ stroke: 'blue' }), false);
expect('layer pointSize', layer({ pointSize: 30 }), true);
expect('layer pointSize zero', layer({ pointSize: 0 }), false);
expect('layer width zero', layer({ width: 0 }), false);
expect('layer width negative', layer({ width: -2 }), false);
expect('layer width as a string', layer({ width: '2' }), false);
expect('colorMapCenter as a string', layer({ colorMapCenter: '0' }), false);
expect('colorMapReverse as a string', layer({ colorMapReverse: 'yes' }), false);
expect('transferFunction as a number', layer({ transferFunction: 1 }), false);
expect('transferFunction with an unknown mode', layer({ transferFunction: { mode: 'log' } }), false);
expect('transferFunction opacity above 1', layer({ transferFunction: { opacityMin: 1.5 } }), false);
expect('transferFunction opacity below 0', layer({ transferFunction: { opacityMax: -0.1 } }), false);
expect('transferFunction gamma zero', layer({ transferFunction: { gamma: 0 } }), false);
expect('transferFunction zeroCenter as a string', layer({ transferFunction: { zeroCenter: '0' } }), false);
expect('colorMapRange with one number', layer({ colorMapRange: [0] }), false);
expect('colorMapRange with three numbers', layer({ colorMapRange: [0, 5, 10] }), false);
expect('colorMapRange with a string', layer({ colorMapRange: [0, '10'] }), false);
expect('colorMapRange as a number', layer({ colorMapRange: 10 }), false);
expect('colorMapRange as an object', layer({ colorMapRange: { low: 0, high: 10 } }), false);
expect('colorMapRange with low equal to high', layer({ colorMapRange: [5, 5] }), false);
expect('colorMapRange with colorMapDomain', layer({ colorMapRange: [0, 10], colorMapDomain: ['a', 'b'] }), false);
expect('colorMapRange with an empty colorMapDomain', layer({ colorMapRange: [0, 10], colorMapDomain: [] }), false);
// A range whose low is above its high is refused when the spec runs (tests/grammar.spec.ts): JSON Schema
// cannot compare two values of a document.
// An OSM queryArea is a bbox [west, south, east, north] in degrees, or geocodeArea with areas, never both.
// West < east and south < north are checked when the spec runs (tests/grammar.spec.ts).
expect('osm bbox with three numbers', osmIn({ bbox: box.slice(0, 3) }), false);
expect('osm bbox with five numbers', osmIn({ bbox: [...box, 0] }), false);
expect('osm bbox with a string', osmIn({ bbox: [...box.slice(0, 3), '41.9'] }), false);
expect('osm bbox as an object', osmIn({ bbox: { west: box[0], south: box[1], east: box[2], north: box[3] } }), false);
expect('osm bbox west below -180', osmIn({ bbox: [-180.5, box[1], box[2], box[3]] }), false);
expect('osm bbox east above 180', osmIn({ bbox: [box[0], box[1], 180.5, box[3]] }), false);
expect('osm bbox south below -90', osmIn({ bbox: [box[0], -90.5, box[2], box[3]] }), false);
expect('osm bbox north above 90', osmIn({ bbox: [box[0], box[1], box[2], 90.5] }), false);
expect('osm bbox with geocodeArea and areas', osmIn({ bbox: box, geocodeArea: 'Chicago', areas: ['Loop'] }), false);
expect('osm bbox with geocodeArea', osmIn({ bbox: box, geocodeArea: 'Chicago' }), false);
expect('osm bbox with areas', osmIn({ bbox: box, areas: ['Loop'] }), false);
expect('osm queryArea without bbox or geocodeArea', osmIn({}), false);
expect('camera pitch above 90', { map: { ...layers, camera: { pitch: 91 } } }, false);
expect('camera pitch below 0', { map: { ...layers, camera: { pitch: -1 } } }, false);
expect('camera bearing above 360', { map: { ...layers, camera: { bearing: 361 } } }, false);
expect('camera zoom below 0', { map: { ...layers, camera: { zoom: -1 } } }, false);
expect('camera zoom as a string', { map: { ...layers, camera: { zoom: '12' } } }, false);
expect('layout with an unknown type', { map: layers, layout: { type: 'diagonal' } }, false);
expect('layout grid with zero columns', { map: layers, layout: { type: 'grid', columns: 0 } }, false);
expect('layout with a negative gap', { map: layers, layout: { gap: -1 } }, false);
expect('map with an empty id', { map: { ...layers, id: '' } }, false);
expect('plot with an empty id', { plot: { ...plot, mark: 'scatter', id: '' } }, false);
expect('link without a source', { map: layers, links: [{ target: 'm' }] }, false);
expect('link without a target', { map: layers, links: [{ source: 'p' }] }, false);
expect('link with an empty layer', { map: layers, links: [{ source: 'p', target: 'm', layer: '' }] }, false);
expect('links as an object', { map: layers, links: { source: 'p', target: 'm' } }, false);

// Each layer styling option is documented in the schema.
const layerProperties = schema.definitions?.MapLayerSpec?.properties ?? {};
for (const key of ['title', 'color', 'width', 'stroke', 'colorMapCenter', 'colorMapReverse', 'colorMapRange', 'transferFunction']) {
    const description = layerProperties[key]?.description;
    if (typeof description !== 'string' || description.trim() === '') {
        failures++;
        console.error(`FAIL MapLayerSpec.${key} has no description in the schema`);
    }
}
// So is the OSM bbox.
const bboxDescription = schema.definitions?.OsmBoundingBoxArea?.properties?.bbox?.description;
if (typeof bboxDescription !== 'string' || bboxDescription.trim() === '') {
    failures++;
    console.error('FAIL OsmBoundingBoxArea.bbox has no description in the schema');
}

if (checked === 0) {
    failures++;
    console.error('FAIL no gallery specs were found');
}
console.log(`${checked} gallery specs checked, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
