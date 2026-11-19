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
expect('points layer pointSize in meters', { map: { layerRefs: [{ dataRef: 't', pointSize: 2 }] } }, true);
expect('points layer pointSize below a meter', { map: { layerRefs: [{ dataRef: 't', pointSize: 0.5 }] } }, true);
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
// OSM tag sets, as autk-db's checkTagSets takes them: at most 8 sets, each a name, a geometry type and 1 to 64 tags.
// A field given as undefined is left out.
const tagSet = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries({
    name: 'cafes', type: 'points', tags: [{ key: 'amenity', value: 'cafe' }], ...fields,
}).filter(([, value]) => value !== undefined));
const withTagSets = (tagSets: unknown, fields: Record<string, unknown> = {}) => ({ data: [{ ...osm, tagSets, ...fields }] });
expect('osm tag sets of each geometry type, without autoLoadLayers', withTagSets([
    tagSet({}),
    tagSet({ name: 'paths_2', type: 'polylines', tags: [{ key: 'highway' }] }),
    tagSet({ name: 'parks', type: 'polygons', tags: [{ key: 'leisure', value: 'park' }, { key: 'addr:street' }] }),
]), true);
expect('osm tag sets with layers', withTagSets([tagSet({})], { autoLoadLayers: { layers: ['roads'] } }), true);
expect('osm with a pbf and no tag sets', withTagSets([], { pbfFileUrl: 'downtown.osm.pbf' }), true);
expect('osm with forceRefresh', { data: [{ ...osm, forceRefresh: true }] }, true);
expect('osm with forceRefresh as a string', { data: [{ ...osm, forceRefresh: 'yes' }] }, false);
expect('osm layers with the CRS of their coordinates', { data: [{ ...osm, autoLoadLayers: { layers: ['roads'], coordinateFormat: 'EPSG:4269' } }] }, true);
expect('osm layers with a CRS as a number', { data: [{ ...osm, autoLoadLayers: { layers: ['roads'], coordinateFormat: 4269 } }] }, false);
expect('a layer and a plot of osm elements', { map: { layerRefs: [{ dataRef: 't', osmElements: true }] }, plot: { ...plot, mark: 'table', osmElements: true } }, true);
expect('a layer with osmElements as a string', { map: { layerRefs: [{ dataRef: 't', osmElements: 'yes' }] } }, false);
expect('a plot with osmElements as a string', { plot: { ...plot, mark: 'scatter', osmElements: 'yes' } }, false);

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
const drawnTypes = ['surface', 'parks', 'water', 'roads', 'buildings', 'polygons', 'polylines'];
expect('render pass with a layer of each type it draws', { compute: [{ ...render, layers: drawnTypes.map((type) => ({ id: type, dataRef: type, type })) }] }, true);
expect('render pass with a points layer, which it cannot draw', { compute: [{ ...render, layers: [{ id: 'p', dataRef: 'p', type: 'points' }] }] }, false);
const heat = { type: 'heatmap', outputTableName: 'h', joinDataRef: 'n', near: { distance: 500 }, grid: { rows: 10, columns: 10 } };
expect('heatmap with useCentroid', { data: [{ ...heat, near: { distance: 500, useCentroid: false } }] }, true);
expect('heatmap with a non-boolean useCentroid', { data: [{ ...heat, near: { distance: 500, useCentroid: 'no' } }] }, false);
expect('heatmap groupBy with count', { data: [{ ...heat, groupBy: [{ column: 'Unique Key', aggregateFn: 'count' }] }] }, true);
expect('heatmap groupBy with collect, which lists rows while a cell holds one value', { data: [{ ...heat, groupBy: [{ column: 'date', aggregateFn: 'collect' }] }] }, false);
expect('join groupBy with collect', { data: [{ type: 'join', dataRef: 't', joinDataRef: 'n', groupBy: [{ column: 'date', aggregateFn: 'collect' }] }] }, true);
expect('heatmap groupBy with normalize', { data: [{ ...heat, groupBy: [{ column: 'Unique Key', aggregateFn: 'count', normalize: true }] }] }, true);
expect('heatmap groupBy with normalize as a string', { data: [{ ...heat, groupBy: [{ column: 'Unique Key', aggregateFn: 'count', normalize: 'yes' }] }] }, false);
expect('workspaces on sources, a map, a plot and a compute pass', {
    data: [{ type: 'geojson', outputTableName: 'g', geojsonFileUrl: 'g.json', workspace: 'west' }, { type: 'join', dataRef: 'g', joinDataRef: 'g', workspace: 'west' }],
    compute: [{ dataRef: 'g', attributes: { x: 'a' }, outputColumnName: 'r', wgslFunction: 'return x;', workspace: 'west' }],
    map: { workspace: 'west', layerRefs: [{ dataRef: 'g' }] },
    plot: { workspace: 'west', dataRef: 'g', mark: 'scatter', axis: ['a', 'b'] },
}, true);
expect('an empty workspace name', { data: [{ type: 'geojson', outputTableName: 'g', geojsonFileUrl: 'g.json', workspace: '' }] }, false);
const crs = { coordinateFormat: 'EPSG:3857', precisionGrid: 1 };
expect('workspaces, the default one and a named one', { workspaces: [crs, { name: 'west', coordinateFormat: 'EPSG:32618', precisionGrid: 0.1 }], data: [csv] }, true);
expect('a workspace without a precision grid', { workspaces: [{ coordinateFormat: 'EPSG:3857' }] }, false);
expect('a workspace without a CRS', { workspaces: [{ precisionGrid: 1 }] }, false);
expect('a workspace with an empty CRS', { workspaces: [{ ...crs, coordinateFormat: '' }] }, false);
expect('a workspace with a precision grid of 0', { workspaces: [{ ...crs, precisionGrid: 0 }] }, false);
expect('a workspace with a negative precision grid', { workspaces: [{ ...crs, precisionGrid: -1 }] }, false);
expect('a workspace with a precision grid as a string', { workspaces: [{ ...crs, precisionGrid: '1' }] }, false);
expect('a workspaces entry with an empty name', { workspaces: [{ ...crs, name: '' }] }, false);
expect('workspaces as an object', { workspaces: crs }, false);
const sql = { type: 'sql', outputTableName: 's', query: "SELECT * FROM t WHERE properties->>'kind' = 'park'" };
expect('sql source', { data: [osm, sql] }, true);
expect('sql source drawn as polygons, in a workspace', { data: [osm, { ...sql, layerType: 'polygons', workspace: 'west' }] }, true);
expect('sql source without a query', { data: [{ type: 'sql', outputTableName: 's' }] }, false);
expect('sql source with an empty query', { data: [{ ...sql, query: '' }] }, false);
expect('sql source with a query as lines', { data: [{ ...sql, query: ['SELECT *', 'FROM t'] }] }, false);
expect('sql source without outputTableName', { data: [{ type: 'sql', query: sql.query }] }, false);
expect('sql source with an unknown layer type', { data: [{ ...sql, layerType: 'rivers' }] }, false);
const rows = { type: 'update', dataRef: 'sales', strategy: 'replace', jsonObject: [{ month: 'May', total: 7 }] };
const features = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: point, properties: { id: 2 } }] };
expect('update with rows replacing a table', { data: [csv, rows] }, true);
expect('update of rows by an id column, in a workspace', { data: [csv, { ...rows, strategy: 'update', idColumn: 'month', workspace: 'west' }] }, true);
expect('update of features by a property', { data: [{ type: 'update', dataRef: 'g', strategy: 'update', idColumn: 'properties.id', geojsonObject: features }] }, true);
expect('update with features replacing a table', { data: [{ type: 'update', dataRef: 'g', strategy: 'replace', geojsonObject: features }] }, true);
expect('update without rows', { data: [{ type: 'update', dataRef: 'sales', strategy: 'replace' }] }, false);
expect('update with rows and features', { data: [{ ...rows, geojsonObject: features }] }, false);
expect('update of rows without an id column', { data: [{ ...rows, strategy: 'update' }] }, false);
expect('update of features without an id column', { data: [{ type: 'update', dataRef: 'g', strategy: 'update', geojsonObject: features }] }, false);
expect('update without a strategy', { data: [{ type: 'update', dataRef: 'sales', jsonObject: rows.jsonObject }] }, false);
expect('update with an unknown strategy', { data: [{ ...rows, strategy: 'upsert' }] }, false);
expect('update without dataRef', { data: [{ type: 'update', strategy: 'replace', jsonObject: rows.jsonObject }] }, false);
expect('update with no rows in jsonObject', { data: [{ ...rows, jsonObject: [] }] }, false);
expect('update with an empty id column', { data: [{ ...rows, strategy: 'update', idColumn: '' }] }, false);
expect('update with a FeatureCollection of no features', { data: [{ type: 'update', dataRef: 'g', strategy: 'replace', geojsonObject: { type: 'FeatureCollection', features: [] } }] }, false);
expect('drop', { data: [csv, { type: 'drop', dataRef: 'c' }] }, true);
expect('drop in a workspace', { data: [{ type: 'drop', dataRef: 'c', workspace: 'west' }] }, true);
expect('drop without dataRef', { data: [{ type: 'drop' }] }, false);
expect('drop with dataRef as a number', { data: [{ type: 'drop', dataRef: 3 }] }, false);
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
expect('layer pointSize of 0 m', layer({ pointSize: 0 }), false);
expect('layer pointSize negative', layer({ pointSize: -2 }), false);
expect('layer pointSize as a string', layer({ pointSize: '2' }), false);
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
expect('osm tag sets with a pbf, which autk-db refuses', withTagSets([tagSet({})], { pbfFileUrl: 'downtown.osm.pbf' }), false);
expect('osm tag sets as an object', withTagSets(tagSet({})), false);
expect('osm nine tag sets', withTagSets(Array.from({ length: 9 }, (_, i) => tagSet({ name: `set_${i}` }))), false);
expect('osm tag set of an unknown type', withTagSets([tagSet({ type: 'lines' })]), false);
expect('osm tag set without a type', withTagSets([tagSet({ type: undefined })]), false);
expect('osm tag set without a name', withTagSets([tagSet({ name: undefined })]), false);
expect('osm tag set name with a capital', withTagSets([tagSet({ name: 'Cafes' })]), false);
expect('osm tag set name starting with a digit', withTagSets([tagSet({ name: '1cafes' })]), false);
expect('osm tag set name of 33 characters', withTagSets([tagSet({ name: `c${'a'.repeat(32)}` })]), false);
expect('osm tag set without tags', withTagSets([tagSet({ tags: [] })]), false);
expect('osm tag set of 65 tags', withTagSets([tagSet({ tags: Array.from({ length: 65 }, (_, i) => ({ key: `k${i}` })) })]), false);
expect('osm tag without a key', withTagSets([tagSet({ tags: [{ value: 'cafe' }] })]), false);
expect('osm tag key with a space', withTagSets([tagSet({ tags: [{ key: 'amenity type' }] })]), false);
expect('osm tag key starting with a colon', withTagSets([tagSet({ tags: [{ key: ':amenity' }] })]), false);
expect('osm tag with an empty value', withTagSets([tagSet({ tags: [{ key: 'amenity', value: '' }] })]), false);
expect('osm tag value of 256 characters', withTagSets([tagSet({ tags: [{ key: 'name', value: 'x'.repeat(256) }] })]), false);
expect('camera pitch above 90', { map: { ...layers, camera: { pitch: 91 } } }, false);
expect('camera pitch of 90, which puts the eye on the ground', { map: { ...layers, camera: { pitch: 90 } } }, false);
expect('camera pitch just below 90', { map: { ...layers, camera: { pitch: 89.9 } } }, true);
expect('camera pitch below 0', { map: { ...layers, camera: { pitch: -1 } } }, false);
expect('camera bearing above 360', { map: { ...layers, camera: { bearing: 361 } } }, false);
expect('camera zoom below 0', { map: { ...layers, camera: { zoom: -1 } } }, false);
expect('camera zoom as a string', { map: { ...layers, camera: { zoom: '12' } } }, false);
expect('layout with an unknown type', { map: layers, layout: { type: 'diagonal' } }, false);
expect('layout grid with zero columns', { map: layers, layout: { type: 'grid', columns: 0 } }, false);
expect('layout grid with columns that are not a whole number', { map: layers, layout: { type: 'grid', columns: 2.5 } }, false);
expect('layout with a negative gap', { map: layers, layout: { gap: -1 } }, false);
expect('map with an empty id', { map: { ...layers, id: '' } }, false);
expect('plot with an empty id', { plot: { ...plot, mark: 'scatter', id: '' } }, false);
expect('link without a source', { map: layers, links: [{ target: 'm' }] }, false);
expect('link without a target', { map: layers, links: [{ source: 'p' }] }, false);
expect('link with an empty layer', { map: layers, links: [{ source: 'p', target: 'm', layer: '' }] }, false);
expect('links as an object', { map: layers, links: { source: 'p', target: 'm' } }, false);

// Plot keys, valid and refused. Keys the schema does not name are allowed, so each refused form is valid until its
// key is typed.
const plotWith = (fields: Record<string, unknown>, mark = 'bar') => ({ plot: { ...plot, mark, color: 'b', ...fields } });
expect('plot color schemes', plotWith({ colorMapInterpolator: 'interpolateViridis', categoricalColorMapInterpolator: 'schemeTableau10' }), true);
expect('plot diverging scheme', plotWith({ colorMapInterpolator: 'interpolateRdBu' }, 'scatter'), true);
expect('plot colorMapInterpolator of categories', plotWith({ colorMapInterpolator: 'schemeSet1' }), false);
expect('plot categoricalColorMapInterpolator of numbers', plotWith({ categoricalColorMapInterpolator: 'interpolateBlues' }, 'scatter'), false);
expect('plot with an unknown color scheme', plotWith({ colorMapInterpolator: 'rainbow' }), false);
expect('plot color range', plotWith({ colorMapRange: [0, 60] }), true);
expect('plot color domain', plotWith({ colorMapDomain: ['oak', 'elm'] }, 'parallel-coordinates'), true);
expect('plot percentile normalization', plotWith({ normalization: { mode: 'percentile', lowerPercentile: 5, upperPercentile: 95 } }), true);
expect('plot min-max normalization with a range', plotWith({ normalization: { mode: 'minMax' }, colorMapRange: [-1, 1] }, 'scatter'), true);
expect('plot colorMapRange with one number', plotWith({ colorMapRange: [0] }), false);
expect('plot colorMapRange with three numbers', plotWith({ colorMapRange: [0, 5, 10] }), false);
expect('plot colorMapRange with a string', plotWith({ colorMapRange: [0, '10'] }), false);
expect('plot colorMapRange as a number', plotWith({ colorMapRange: 10 }), false);
expect('plot colorMapRange with low equal to high', plotWith({ colorMapRange: [5, 5] }), false);
expect('plot colorMapRange with colorMapDomain', plotWith({ colorMapRange: [0, 10], colorMapDomain: ['a', 'b'] }), false);
expect('plot colorMapRange with an empty colorMapDomain', plotWith({ colorMapRange: [0, 10], colorMapDomain: [] }, 'scatter'), false);
expect('plot colorMapDomain as a string', plotWith({ colorMapDomain: 'oak' }), false);
expect('plot colorMapDomain with a number', plotWith({ colorMapDomain: ['oak', 3] }), false);
expect('plot normalization of an unknown mode', plotWith({ normalization: { mode: 'log' } }), false);
expect('plot normalization without a mode', plotWith({ normalization: { lowerPercentile: 5 } }), false);
expect('plot normalization as a string', plotWith({ normalization: 'percentile' }), false);

// Each layer styling option is documented in the schema.
const layerProperties = schema.definitions?.MapLayerSpec?.properties ?? {};
for (const key of ['title', 'color', 'width', 'pointSize', 'stroke', 'colorMapCenter', 'colorMapReverse', 'colorMapRange', 'transferFunction']) {
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
// So is every key 5.0.0 adds or renames, and every key added since. A path of keys from a definition is followed through `$ref`, each branch of
// `anyOf` and `allOf` (a discriminated union's `then`) and an array's `items`. The key must be reached at least once,
// and carry a description everywhere it is reached; an empty path checks the definition itself.
type SchemaNode = Record<string, any>;
function objectsOf(node: SchemaNode | SchemaNode[] | undefined): SchemaNode[] {
    if (Array.isArray(node)) return node.flatMap(objectsOf);
    if (!node || typeof node !== 'object') return [];
    if (typeof node.$ref === 'string')
        return objectsOf(schema.definitions?.[decodeURIComponent(node.$ref.replace('#/definitions/', ''))]);
    const branches = [...(node.anyOf ?? []), ...(node.allOf ?? []), node.then, node.else, node.items];
    return [...(node.properties ? [node] : []), ...branches.flatMap(objectsOf)];
}
function keysAt(definition: string, path: string): SchemaNode[] {
    let nodes: SchemaNode[] = [schema.definitions?.[definition]].filter((node) => node !== undefined);
    for (const key of path ? path.split('.') : [])
        nodes = objectsOf(nodes).map((node) => node.properties?.[key]).filter((node) => node !== undefined);
    return nodes;
}
const newKeys: Array<[string, string[]]> = [
    ['UrbanSpec', [
        'layout', 'layout.type', 'layout.columns', 'layout.gap',
        'links', 'links.source', 'links.target', 'links.layer',
        'map.id', 'map.workspace', 'map.camera', 'map.camera.zoom', 'map.camera.pitch', 'map.camera.bearing',
        'plot.id', 'plot.workspace', 'data.workspace', 'compute.workspace',
    ]],
    ['WorkspaceName', ['']],
    ['CustomDataSourceSpec', ['layerType']],
    ['GeoTiffDataSourceSpec', ['geotiffFileUrl', 'coordinateFormat', 'maxRasterCells', 'resampleMethod']],
    ['JoinSourceSpec', ['dataRef', 'joinDataRef', 'near.useCentroid']],
    ['HeatmapSourceSpec', ['joinDataRef', 'near.useCentroid']],
    ['GpgpuComputeSpec', ['type', 'wgslFunction', 'outputTableName', 'layerType']],
    ['RenderComputeSpec', [
        'type', 'outputTableName', 'layerType', 'tileSize',
        'layers', 'layers.id', 'layers.dataRef', 'layers.type', 'layers.objectIdProperty',
        'viewpoints', 'viewpoints.dataRef', 'viewpoints.strategy', 'viewpoints.strategy.floors',
        'viewpoints.sampling', 'viewpoints.sampling.directions', 'viewpoints.sampling.azimuthOffsetDeg',
        'viewpoints.sampling.pitchDeg',
        'aggregation', 'aggregation.includeBackground', 'aggregation.backgroundLayerType',
        'camera', 'camera.fov', 'camera.clip', 'camera.clip.near', 'camera.clip.far',
    ]],
    ['OsmDataSourceSpec', ['tagSets', 'tagSets.name', 'tagSets.type', 'tagSets.tags', 'tagSets.tags.key', 'tagSets.tags.value']],
    ['OsmTagSet', ['']],
    ['OsmTagFilter', ['']],
    ['UrbanSpec', ['workspaces', 'workspaces.name', 'workspaces.coordinateFormat', 'workspaces.precisionGrid']],
    ['WorkspaceSpec', ['']],
    ['SqlSourceSpec', ['', 'query', 'layerType']],
    ['HeatmapSourceSpec', ['groupBy.normalize']],
    ['OsmDataSourceSpec', ['forceRefresh', 'autoLoadLayers.coordinateFormat']],
    ['MapLayerSpec', ['osmElements']],
    ['UrbanSpec', ['plot.osmElements']],
    ['UpdateSourceSpec', ['', 'workspace', 'dataRef', 'strategy', 'idColumn', 'geojsonObject', 'jsonObject']],
    ['DropSourceSpec', ['', 'workspace', 'dataRef']],
    ['UrbanSpec', ['plot.color', 'plot.colorMapInterpolator', 'plot.categoricalColorMapInterpolator']],
    ['UrbanSpec', ['plot.normalization', 'plot.colorMapRange', 'plot.colorMapDomain']],
];
for (const [definition, paths] of newKeys) {
    for (const path of paths) {
        const name = path ? `${definition}.${path}` : definition;
        const nodes = keysAt(definition, path);
        if (nodes.length === 0) {
            failures++;
            console.error(`FAIL ${name} is not in the schema`);
        } else if (nodes.some((node) => typeof node.description !== 'string' || node.description.trim() === '')) {
            failures++;
            console.error(`FAIL ${name} has no description in the schema`);
        }
    }
}

if (checked === 0) {
    failures++;
    console.error('FAIL no gallery specs were found');
}
console.log(`${checked} gallery specs checked, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
