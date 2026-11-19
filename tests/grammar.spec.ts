import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type {
    CameraSpec, ColorMapInterpolator, DataSourceSpec, GeoTiffDataSourceSpec, HeatmapSourceSpec, MapLayerSpec, MapSpec, PlotSpec,
    RenderComputeSpec, TerrainSpec, UrbanSpec,
} from '@urban-toolkit/the-urban-grammar';
import type { DrawnMark, LayerState, PaneBox, RunSummary } from './app/main';
import { spec as interactionExternal } from '../gallery/src/examples/interaction-external';
import { spec as heatmapGeojson } from '../gallery/src/examples/heatmap-vis-geojson';

// Runs gallery example specs end to end (data, compute, map, plot) so an Autark
// release that breaks the grammar fails here. See tests/README.md.

let pageErrors: string[] = [];
let adapterLogged = false;

test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto('/');
    // A freshly launched Chrome can answer requestAdapter() with null until its GPU process has
    // started (about a second on the Linux GPU runner), so wait for an adapter before running specs.
    const adapter = await page.evaluate(async () => {
        for (let attempt = 0; attempt < 40; attempt++) {
            const found = await navigator.gpu?.requestAdapter();
            if (found) return `${found.info?.vendor} ${found.info?.architecture}`;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return null;
    });
    expect(adapter, 'this browser has no WebGPU adapter').not.toBeNull();
    if (!adapterLogged) console.log(`WebGPU adapter: ${adapter}`);
    adapterLogged = true;
});

test.afterEach(() => {
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

function run(page: Page, example: string): Promise<RunSummary> {
    return page.evaluate((name) => window.runExample(name), example);
}

function runSpec(page: Page, spec: UrbanSpec, plotTargets?: 'one' | 'each'): Promise<RunSummary> {
    return page.evaluate(([s, targets]) => window.runSpec(s, targets), [spec, plotTargets] as const);
}

/**
 * Fails when a map canvas is a single flat color, i.e. nothing was drawn. Reads the canvas
 * itself (window.readMap), in the frame that draws the map, so the map's controls and
 * watermark on top of it are not counted.
 */
async function expectDrawn(page: Page, canvasId: string, minColors = 8) {
    await page.waitForTimeout(1500);
    const dataUrl = await page.evaluate((id) => window.readMap(id), canvasId);
    const image = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    await test.info().attach(`${canvasId}.png`, { body: image, contentType: 'image/png' });
    const png = PNG.sync.read(image);
    const colors = new Set<number>();
    for (let i = 0; i < png.data.length && colors.size < 16; i += 4 * 97) {
        colors.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
    }
    expect(colors.size, `#${canvasId} looks blank`).toBeGreaterThan(minColors);
}

test('loads CSV and JSON sources', async ({ page }) => {
    const { tables } = await run(page, 'load-multiple');
    expect(tables.noise.features).toBeGreaterThan(1000);
    expect(tables.noise.properties).toContain('Unique Key');
});

test('draws a GeoJSON layer', async ({ page }) => {
    const { tables } = await run(page, 'geojson-vis');
    expect(tables.neighborhoods.features).toBe(38);
    await expectDrawn(page, 'map0');
});

test('builds OSM layer tables from a PBF file', async ({ page }) => {
    const { tables } = await run(page, 'osm-layers-pbf');
    for (const layer of ['surface', 'parks', 'water', 'roads', 'buildings']) {
        expect(tables[`table_osm_${layer}`]?.features, `table_osm_${layer}`).toBeGreaterThan(0);
    }
    await expectDrawn(page, 'map0');
});

// A box around Wall Street, inside the gallery's lower Manhattan extract: [west, south, east, north] in degrees.
const BOX = [-74.0125, 40.705, -74.008, 40.7085];

/** Reads the lower Manhattan extract for `queryArea` into the tables box_surface, box_roads and box_buildings. */
function boxSpec(queryArea: unknown): UrbanSpec {
    const source = {
        type: 'osm',
        outputTableName: 'box',
        pbfFileUrl: '/data/lower_mnt.osm.pbf',
        queryArea,
        autoLoadLayers: { layers: ['surface', 'roads', 'buildings'] },
    };
    return { data: [source as DataSourceSpec] };
}

/** A point given in degrees, in autk-db's workspace coordinates: World Mercator (EPSG:3395) meters, on the WGS84 ellipsoid. */
function worldMercator(lon: number, lat: number): [number, number] {
    const a = 6378137;
    const e = 0.0818191908426215;
    const phi = (lat * Math.PI) / 180;
    const s = e * Math.sin(phi);
    return [(a * lon * Math.PI) / 180, a * Math.log(Math.tan(Math.PI / 4 + phi / 2) * ((1 - s) / (1 + s)) ** (e / 2))];
}

test('loads the OSM layers inside a bbox from a PBF file', async ({ page }) => {
    const { tables } = await runSpec(page, {
        ...boxSpec({ bbox: BOX }),
        map: { layerRefs: [{ dataRef: 'box_surface' }, { dataRef: 'box_roads' }, { dataRef: 'box_buildings' }] },
    });
    for (const layer of ['surface', 'roads', 'buildings']) {
        expect(tables[`box_${layer}`]?.features, `box_${layer}`).toBeGreaterThan(0);
    }

    // autk-db cuts the surface and the roads to the box, and keeps or drops each building whole: a building
    // may reach past the box, but not lie apart from it. 1 m covers autk-db's rounding.
    const [west, south] = worldMercator(BOX[0], BOX[1]);
    const [east, north] = worldMercator(BOX[2], BOX[3]);
    const inside = ([x0, y0, x1, y1]: number[]) => x0 >= west - 1 && y0 >= south - 1 && x1 <= east + 1 && y1 <= north + 1;
    const touches = ([x0, y0, x1, y1]: number[]) => x1 >= west - 1 && y1 >= south - 1 && x0 <= east + 1 && y0 <= north + 1;
    const extents = (table: string) => page.evaluate((name) => window.featureExtents(name), table);
    expect((await extents('box_surface')).filter((extent) => !inside(extent)), 'surface outside the box').toEqual([]);
    expect((await extents('box_roads')).filter((extent) => !inside(extent)), 'roads outside the box').toEqual([]);
    expect((await extents('box_buildings')).filter((extent) => !touches(extent)), 'buildings apart from the box').toEqual([]);
    await expectDrawn(page, 'map0');
});

test('refuses a bbox that is not [west, south, east, north] in degrees, and a bbox with named areas', async ({ page }) => {
    const refused = (queryArea: unknown, message: string) =>
        expect(runSpec(page, boxSpec(queryArea))).rejects.toThrow(`OSM source "box": ${message}`);
    const shape = 'queryArea.bbox must hold four numbers, [west, south, east, north] in degrees.';
    await refused({ bbox: BOX.slice(0, 3) }, shape);
    await refused({ bbox: [...BOX, 0] }, shape);
    await refused({ bbox: [...BOX.slice(0, 3), '40.7085'] }, shape);
    await refused({ bbox: [-181, 40.705, -74.008, 40.7085] }, 'queryArea.bbox west and east must be longitudes from -180 to 180.');
    await refused({ bbox: [-74.0125, 40.705, -74.008, 90.5] }, 'queryArea.bbox south and north must be latitudes from -90 to 90.');
    await refused({ bbox: [-74.008, 40.705, -74.0125, 40.7085] }, 'queryArea.bbox west (-74.008) must be less than east (-74.0125)');
    await refused({ bbox: [-74.0125, 40.705, -74.008, 40.705] }, 'queryArea.bbox south (40.705) must be less than north (40.705).');
    const both = 'queryArea takes either bbox or geocodeArea with areas, not both.';
    await refused({ bbox: BOX, geocodeArea: 'New York', areas: ['Financial District'] }, both);
    await refused({ bbox: BOX, areas: ['Financial District'] }, both);
});

// OSM tag sets, read from an Overpass API the test answers itself, so a run needs no network. Inside BOX: two cafes and
// a bench, a footway, and a park.
const TAGGED = {
    version: 0.6,
    elements: [
        { type: 'node', id: 1, lat: 40.706, lon: -74.011, tags: { amenity: 'cafe', name: 'Cafe One' } },
        { type: 'node', id: 2, lat: 40.707, lon: -74.01, tags: { amenity: 'cafe', name: 'Cafe Two' } },
        { type: 'node', id: 3, lat: 40.7075, lon: -74.0095, tags: { amenity: 'bench' } },
        {
            type: 'way', id: 10, nodes: [11, 12, 13], tags: { highway: 'footway' },
            geometry: [{ lat: 40.7055, lon: -74.012 }, { lat: 40.7065, lon: -74.0105 }, { lat: 40.708, lon: -74.009 }],
        },
        {
            type: 'way', id: 20, nodes: [21, 22, 23, 24, 21], tags: { leisure: 'park', name: 'Pocket Park' },
            geometry: [
                { lat: 40.7062, lon: -74.0115 }, { lat: 40.7062, lon: -74.0105 }, { lat: 40.7072, lon: -74.0105 },
                { lat: 40.7072, lon: -74.0115 }, { lat: 40.7062, lon: -74.0115 },
            ],
        },
    ],
};

/** An OSM source for BOX with three tag sets, and no layers: the cafes as points, the highways as lines, the parks as polygons. */
function taggedSource(fields: object = {}): DataSourceSpec {
    return {
        type: 'osm',
        outputTableName: 'osm',
        queryArea: { bbox: BOX },
        tagSets: [
            { name: 'cafes', type: 'points', tags: [{ key: 'amenity', value: 'cafe' }] },
            { name: 'paths', type: 'polylines', tags: [{ key: 'highway' }] },
            { name: 'parks', type: 'polygons', tags: [{ key: 'leisure', value: 'park' }] },
        ],
        ...fields,
    } as DataSourceSpec;
}

/**
 * Answers the page's Overpass API requests: the query of a source's tag sets with `answer`, any other (the coastline
 * query) with no elements. Returns the queries the page sends, in the order it sends them, as they come. autk-db asks the
 * API's status for a free slot before each query; an answer that is not ok lets it go on at once.
 */
async function answerOverpass(page: Page, answer: object): Promise<string[]> {
    const queries: string[] = [];
    const headers = { 'access-control-allow-origin': '*' };
    await page.route('https://overpass-api.de/api/status', (route) => route.fulfill({ status: 404, headers, body: '' }));
    await page.route('https://overpass-api.de/api/interpreter', (route) => {
        const query = decodeURIComponent((route.request().postData() ?? '').replace(/^data=/, ''));
        queries.push(query);
        const body = query.includes('->.tagHits') ? answer : { elements: [] };
        return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return queries;
}

/** The value at `path` of each of the first `count` features of `table`. */
function valuesOf(page: Page, table: string, count: number, path: string): Promise<unknown[]> {
    return page.evaluate(async ({ table, count, path }) => {
        const values: unknown[] = [];
        for (let i = 0; i < count; i++) values.push(await window.valueAt(table, i, path));
        return values;
    }, { table, count, path });
}

test('loads the features each tag set chooses from Overpass, one table of one geometry type a set', async ({ page }) => {
    const queries = await answerOverpass(page, TAGGED);
    const { tables } = await runSpec(page, {
        data: [taggedSource()],
        map: { layerRefs: [{ dataRef: 'osm_parks_polygons' }, { dataRef: 'osm_paths_polylines' }, { dataRef: 'osm_cafes_points' }] },
    });
    expect(queries.filter((query) => query.includes('->.tagHits')), 'one query for the tag sets').toHaveLength(1);
    // A source with tag sets and no layers makes the tables of its sets alone.
    expect(Object.keys(tables).sort()).toEqual(['osm_cafes_points', 'osm_parks_polygons', 'osm_paths_polylines']);
    // The two cafes, not the bench, whose amenity is another. Each feature's properties are its tags.
    expect(tables.osm_cafes_points.features).toBe(2);
    expect((await valuesOf(page, 'osm_cafes_points', 2, 'name')).sort()).toEqual(['Cafe One', 'Cafe Two']);
    expect(tables.osm_paths_polylines.features).toBe(1);
    expect(await valuesOf(page, 'osm_paths_polylines', 1, 'highway')).toEqual(['footway']);
    expect(tables.osm_parks_polygons.features).toBe(1);
    expect(await valuesOf(page, 'osm_parks_polygons', 1, 'name')).toEqual(['Pocket Park']);
    // A map draws each table as its geometry type.
    expect((await mapLayers(page)).map((layer) => [layer.id, layer.type])).toEqual([
        ['osm_parks_polygons', 'polygons'], ['osm_paths_polylines', 'polylines'], ['osm_cafes_points', 'points'],
    ]);
});

test('queries Overpass again with forceRefresh, and reads the answer the browser cached without it', async ({ page }) => {
    const queries = await answerOverpass(page, TAGGED);
    // The queries sent by the end of each run: a first run, the same spec again, then with forceRefresh.
    const sent: number[] = [];
    for (const fields of [{}, {}, { forceRefresh: true }]) {
        const { tables } = await runSpec(page, { data: [taggedSource(fields)] });
        expect(tables.osm_cafes_points?.features, 'the same tables each run').toBe(2);
        sent.push(queries.length);
    }
    expect(sent[0]).toBeGreaterThan(0);
    expect(sent[1], 'the second run reads the cached answer').toBe(sent[0]);
    expect(sent[2], 'forceRefresh queries the API again').toBe(2 * sent[0]);
});

test('draws and plots an OSM table as one feature per OSM element with osmElements, and row by row without it', async ({ page }) => {
    await runSpec(page, {
        data: [{
            type: 'osm', outputTableName: 'box', pbfFileUrl: '/data/lower_mnt.osm.pbf', queryArea: { bbox: BOX },
            autoLoadLayers: { layers: ['roads', 'buildings'] },
        } as DataSourceSpec],
        map: {
            layerRefs: [
                { dataRef: 'box_buildings', title: 'Building parts', osmElements: true },
                { dataRef: 'box_roads', title: 'Road elements', osmElements: true },
                { dataRef: 'box_roads', title: 'Road rows' },
            ],
        },
        plot: { dataRef: 'box_roads', mark: 'table', axis: ['osm_type', 'osm_id', 'highway'], osmElements: true },
    });
    const drawn = (layerId: string) => page.evaluate((id) => window.drawnRows('map0', id), layerId);
    // Each road element is a way, with its id and its tags.
    const elements = await drawn('Road elements');
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.filter((row) => row?.osm_type !== 'way' || !Number.isInteger(row?.osm_id) || typeof row?.highway !== 'string')).toEqual([]);
    // The same table drawn row by row, from an export of its own: each row holds its tags, and no OSM id.
    const rows = await drawn('Road rows');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row == null || 'osm_id' in row || typeof row.highway !== 'string')).toEqual([]);
    // A building's parts are drawn as elements of their own, each naming its building.
    const parts = await drawn('Building parts');
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.filter((row) => !['way', 'relation'].includes(String(row?.osm_type)) || row?.building_id == null)).toEqual([]);
    // The plot draws a row per road element.
    const plotted = await page.evaluate(() => [...document.querySelectorAll('#plot tr.autkMark')]
        .map((row) => (row as Element & { __data__?: { osm_id?: number } }).__data__?.osm_id));
    const ascending = (ids: unknown[]) => ids.map(Number).sort((a, b) => a - b);
    expect(ascending(plotted)).toEqual(ascending(elements.map((row) => row?.osm_id)));
    await expectDrawn(page, 'map0');
});

test('refuses tag sets with a PBF extract, naming the source', async ({ page }) => {
    // autk-db reads tag sets from the Overpass API only, and refused them with a PBF extract without naming the source.
    await expect(runSpec(page, { data: [taggedSource({ pbfFileUrl: '/data/lower_mnt.osm.pbf' })] }))
        .rejects.toThrow('OSM source "osm": tagSets are read from the Overpass API only, so a source with pbfFileUrl cannot take them.');
});

/** A GeoJSON source of one polygon whose coordinates are declared as EPSG:4326 degrees. */
function onePolygon(name: string, ring: number[][]): DataSourceSpec {
    return {
        type: 'geojson',
        outputTableName: name,
        coordinateFormat: 'EPSG:4326',
        geojsonObject: {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }],
        },
    };
}

/** The message a spec's run is refused with, or '' when it runs. */
function refusal(page: Page, spec: UrbanSpec): Promise<string> {
    return runSpec(page, spec).then(() => '', (error: Error) => error.message);
}

test("reports autk-db's reason for refusing a GeoJSON layer, with no CRS advice", async ({ page }) => {
    // Its points lie on one line, so the polygon has no area and collapses on autk-db's 1 cm grid
    // whatever the CRS (urban-toolkit/curio#899). Its coordinates are the degrees it declares.
    const message = await refusal(page, {
        data: [onePolygon('flat', [[-73.99, 40.75], [-73.985, 40.75], [-73.98, 40.75], [-73.99, 40.75]])],
    });
    expect(message).toContain('Failed to load GeoJSON layer "flat": ');
    expect(message).toContain('collapses');
    expect(message).not.toContain('coordinateFormat');
});

test('refuses a layer of projected meters read as degrees, with its bounding box and CRS advice', async ({ page }) => {
    // A square in Web Mercator meters in Midtown Manhattan, declared as EPSG:4326.
    const message = await refusal(page, {
        data: [onePolygon('meters', [[-8236000, 4975000], [-8235000, 4975000], [-8235000, 4976000], [-8236000, 4976000], [-8236000, 4975000]])],
    });
    expect(message).toContain('bbox: [');
    expect(message).toContain('Verify that coordinateFormat matches the actual CRS of the input data');
});

test('aggregates a spatial join', async ({ page }) => {
    await run(page, 'spatial-join');
    const counts = await page.evaluate(async () => {
        const values: number[] = [];
        for (let i = 0; i < 38; i++) values.push(Number(await window.valueAt('neighborhoods', i, 'sjoin.count.noise') ?? 0));
        return values;
    });
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    await expectDrawn(page, 'map0');
});

test('draws a heatmap raster', async ({ page }) => {
    // Heatmaps are rasters: they are drawn on the map but not listed in grammar.data.
    const { tables } = await run(page, 'heatmap-vis-geojson');
    expect(tables.noise.features).toBeGreaterThan(1000);
    await expectDrawn(page, 'map0');
});

test('runs a GPU compute function', async ({ page }) => {
    await run(page, 'compute-function');
    const compactness = await page.evaluate(() => window.valueAt('neighborhoods', 0, 'compute.result'));
    expect(typeof compactness).toBe('number');
    expect(compactness as number).toBeGreaterThan(0);
    expect(compactness as number).toBeLessThanOrEqual(1);
    await expectDrawn(page, 'map0');
});

test('packs a batched compute past the 64 KiB a uniform buffer holds', async ({ page }) => {
    // 2108 bounding boxes pack into 67,456 B, more than a 64 KiB uniform buffer binding holds:
    // autk-compute 3 failed GPU validation on them and read back zeros. autk-compute 4 reads each
    // packed array from a storage buffer, so every box counts all 2108, the last ones included.
    const n = 2108;
    const square = (i: number) => {
        const x = -71.1 + (i % 50) * 0.002;
        const y = 42.3 + Math.floor(i / 50) * 0.002;
        return { type: 'Polygon' as const, coordinates: [[[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y + 0.001], [x, y]]] };
    };
    const spec: UrbanSpec = {
        data: [{
            type: 'geojson',
            outputTableName: 'boxes',
            geojsonObject: {
                type: 'FeatureCollection',
                features: Array.from({ length: n }, (_, i) => ({ type: 'Feature' as const, properties: { v: 1 }, geometry: square(i) })),
            },
        }],
        compute: [{
            dataRef: 'boxes',
            attributes: { w: 'v' },
            uniforms: { v: { fromFeature: { layer: 'boxes', path: 'properties.v', iterate: 'batched' } } },
            uniformMatrices: { o: { fromFeature: { layer: 'boxes', path: 'geometry.coordinates.0', iterate: 'batched' }, cols: 2 } },
            outputColumnName: 'count',
            // o packs [xmin,ymin, xmax,ymin, xmax,ymax, xmin,ymax] per feature: count the boxes that have a width.
            wgslFunction: [
                'var n = 0.0;',
                'for (var i = 0u; i < u32(num_features); i++) {',
                '    if (o[i * 8u + 2u] > o[i * 8u]) { n += v[i]; }',
                '}',
                'return n * w;',
            ],
        }],
    };
    await runSpec(page, spec);
    const counts = await page.evaluate((last) => Promise.all([
        window.valueAt('boxes', 0, 'compute.count'),
        window.valueAt('boxes', last, 'compute.count'),
    ]), n - 1);
    expect(counts).toEqual([n, n]);
});

test('links a plot to the map', async ({ page }) => {
    const { plotSvgs } = await run(page, 'barchart-click');
    expect(plotSvgs).toBeGreaterThan(0);
    expect(await page.locator('#plot svg rect').count()).toBeGreaterThanOrEqual(38);
    await expectDrawn(page, 'map0');

    // External code can drive the linked views without errors.
    await page.evaluate(() => {
        window.grammar.highlightOnMap('neighborhoods', [0, 1, 2]);
        window.grammar.setPlotSelection('neighborhoods', [0, 1, 2]);
        window.grammar.clearHighlightOnMap('neighborhoods');
        window.grammar.clearHighlightOnPlot('neighborhoods');
    });
});

test('draws a bar chart of a CSV table without coordinates, from its rows', async ({ page }) => {
    // autk-db exports a table as a layer only when it has a geometry, and the plot always asked for that export, so a
    // chart of a CSV or JSON table loaded without geometryColumns failed: "Table sales is not a renderable layer".
    const { plotSvgs } = await runSpec(page, {
        data: [{ type: 'csv', outputTableName: 'sales', csvObject: [['month', 'total'], ['Jan', 3], ['Feb', 5], ['Mar', 2]] }],
        plot: { dataRef: 'sales', mark: 'bar', axis: ['month', 'total'] },
    });
    expect(plotSvgs).toBe(1);
    const bars = await page.evaluate(() => [...document.querySelectorAll('#plot rect.autkMark')]
        .map((bar) => (bar as Element & { __data__?: { month?: string; total?: number } }).__data__)
        .map((datum) => `${datum?.month} ${datum?.total}`));
    expect(bars.sort()).toEqual(['Feb 5', 'Jan 3', 'Mar 2']);
});

test('draws a layer and a plot that name selectFields, and still reports feature ids', async ({ page }) => {
    // interaction-external names nta2020 as the key of its pickable layer and of its plot.
    // Neither adapter reads selectFields: the spec draws as before, and a click on a plot mark
    // reports the clicked feature's id, not its key value.
    expect((interactionExternal.map as MapSpec).layerRefs[0].selectFields).toEqual(['nta2020']);
    expect((interactionExternal.plot as PlotSpec).selectFields).toEqual(['nta2020']);

    const { tables, plotSvgs } = await run(page, 'interaction-external');
    expect(tables.neighborhoods.properties).toContain('nta2020');
    expect(plotSvgs).toBeGreaterThan(0);
    await expectDrawn(page, 'map0');

    expect(await page.locator('#plot .autkMark').count()).toBeGreaterThan(0);
    const { clicked, emitted } = await page.evaluate(() => new Promise<{ clicked: unknown; emitted: unknown }>((resolve) => {
        const mark = document.querySelector('#plot .autkMark') as Element & { __data__?: { autkIds?: number[] } };
        const clicked = mark.__data__?.autkIds;
        window.grammar.interactions.on('plot:selection', ({ selection }) => resolve({ clicked, emitted: selection }));
        setTimeout(() => resolve({ clicked, emitted: 'no plot:selection event within 5 s' }), 5000);
        mark.dispatchEvent(new MouseEvent('click'));
    }));
    expect(clicked).toEqual([expect.any(Number)]);
    expect(emitted).toEqual(clicked);
    const [id] = emitted as number[];
    expect(Number.isInteger(id) && id >= 0 && id < tables.neighborhoods.features, `feature id ${id}`).toBe(true);
});

test('draws two maps from one spec', async ({ page }) => {
    await run(page, 'multi-map');
    await expectDrawn(page, 'map0');
    await expectDrawn(page, 'map1');
});

// Layer options: small inline tables in Midtown Manhattan. `zones`, `blocks` and `lots` are four
// squares each, valued 0 to 30 (`lots` 0 to 60), `paths` three east-west lines. autk-db crops every
// table to the first polygon table it loads, so each spec loads `area`, one square around them all, first.
const area: DataSourceSpec = {
    type: 'geojson',
    outputTableName: 'area',
    geojsonObject: {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[[-74.0, 40.735], [-73.96, 40.735], [-73.96, 40.775], [-74.0, 40.775], [-74.0, 40.735]]] },
        }],
    },
};
function squares(name: string, y: number, step = 10): DataSourceSpec {
    const square = (i: number) => {
        const x = -73.99 + i * 0.004;
        return { type: 'Polygon' as const, coordinates: [[[x, y], [x + 0.003, y], [x + 0.003, y + 0.003], [x, y + 0.003], [x, y]]] };
    };
    return {
        type: 'geojson',
        outputTableName: name,
        geojsonObject: {
            type: 'FeatureCollection',
            features: [0, 1, 2, 3].map((i) => ({ type: 'Feature' as const, properties: { id: i, v: i * step }, geometry: square(i) })),
        },
    };
}
const zones = squares('zones', 40.75);
const blocks = squares('blocks', 40.756);
const lots = squares('lots', 40.762, 20);
const paths: DataSourceSpec = {
    type: 'geojson',
    outputTableName: 'paths',
    geojsonObject: {
        type: 'FeatureCollection',
        features: [0, 1, 2].map((i) => ({
            type: 'Feature' as const,
            properties: { id: i },
            geometry: { type: 'LineString' as const, coordinates: [[-73.99, 40.748 - i * 0.002], [-73.975, 40.748 - i * 0.002]] },
        })),
    },
};
// `spots`: nine points on a grid around the middle of `area`, 0.004 degrees apart, so that autk-map's default
// discs, 128 planar units across, stay apart.
const spots: DataSourceSpec = {
    type: 'geojson',
    outputTableName: 'spots',
    geojsonObject: {
        type: 'FeatureCollection',
        features: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
            type: 'Feature' as const,
            properties: { id: i },
            geometry: { type: 'Point' as const, coordinates: [-73.984 + (i % 3) * 0.004, 40.751 + Math.floor(i / 3) * 0.004] },
        })),
    },
};

function mapLayers(page: Page, canvasId = 'map0'): Promise<LayerState[]> {
    return page.evaluate((id) => window.mapLayers(id), canvasId);
}

async function layerById(page: Page, canvasId = 'map0'): Promise<Record<string, LayerState>> {
    return Object.fromEntries((await mapLayers(page, canvasId)).map((layer) => [layer.id, layer]));
}

test('names a layer by its title, and the legend and the lookup by data name follow it', async ({ page }) => {
    await runSpec(page, {
        data: [area, zones, paths],
        map: { layerRefs: [{ dataRef: 'zones', title: 'Zone value', getFnv: 'v' }, { dataRef: 'paths' }] },
    });
    // The title is the autk-map layer id; a layer without one keeps its dataRef.
    expect((await mapLayers(page)).map((layer) => layer.id).sort()).toEqual(['Zone value', 'paths']);
    expect((await page.evaluate(() => window.legend()))?.title).toBe('Zone value');

    const lookup = await page.evaluate(() => {
        const find = (dataRef: string) => {
            const layer = window.grammar.mapLayer(dataRef);
            return layer ? { layerId: layer.layerId, map: window.grammar.maps.indexOf(layer.map) } : null;
        };
        return { zones: find('zones'), paths: find('paths'), missing: find('missing') };
    });
    expect(lookup).toEqual({ zones: { layerId: 'Zone value', map: 0 }, paths: { layerId: 'paths', map: 0 }, missing: null });
});

test('refuses two layers with one id in a map, and takes one title in two maps', async ({ page }) => {
    await expect(runSpec(page, {
        data: [area, zones, paths],
        map: { layerRefs: [{ dataRef: 'zones', title: 'Same' }, { dataRef: 'paths', title: 'Same' }] },
    })).rejects.toThrow('Map 0 draws two layers with the id "Same"');
    // A title is a layer id, so it cannot be another layer's dataRef in the same map.
    await expect(runSpec(page, {
        data: [area, zones, paths],
        map: { layerRefs: [{ dataRef: 'zones', title: 'paths' }, { dataRef: 'paths' }] },
    })).rejects.toThrow('Map 0 draws two layers with the id "paths"');

    await runSpec(page, {
        data: [area, zones, paths],
        map: [{ layerRefs: [{ dataRef: 'zones', title: 'Same' }] }, { layerRefs: [{ dataRef: 'paths', title: 'Same' }] }],
    });
    expect((await mapLayers(page, 'map0')).map((layer) => layer.id)).toEqual(['Same']);
    expect((await mapLayers(page, 'map1')).map((layer) => layer.id)).toEqual(['Same']);
});

test('links plots to a map by id: two plots of one table, a named layer, and a pick back', async ({ page }) => {
    await runSpec(page, {
        data: [area, zones],
        map: { id: 'zmap', layerRefs: [{ dataRef: 'zones', title: 'Zones' }] },
        plot: [
            { id: 'first', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'], events: ['click'] },
            { id: 'second', dataRef: 'zones', mark: 'scatter', axis: ['v', 'id'], events: ['click'] },
        ],
        links: [{ source: 'first', target: 'zmap' }, { source: 'second', target: 'zmap', layer: 'Zones' }],
    });
    const highlighted = async () => (await layerById(page)).Zones?.highlightedIds;

    // Both plots are known, though they draw one table.
    expect(await page.evaluate(() => [...(window.grammar as any)._plotRegistry.keys()])).toEqual(['first', 'second']);

    // A selection in either plot highlights the layer; the plot's table names the layer when the link does not.
    await page.evaluate(() => (window.grammar as any)._plotRegistry.get('first').events.emit('click', { selection: [1, 2] }));
    expect(await highlighted()).toEqual([1, 2]);
    await page.evaluate(() => (window.grammar as any)._plotRegistry.get('second').events.emit('click', { selection: [3] }));
    expect(await highlighted()).toEqual([3]);

    // A pick on the layer selects the features in both linked plots.
    await page.evaluate(() => window.grammar.maps[0].events.emit('picking' as never, { selection: [2], layerId: 'Zones' } as never));
    expect(await page.evaluate(() => [...(window.grammar as any)._plotRegistry.get('first').selection])).toEqual([2]);
    expect(await page.evaluate(() => [...(window.grammar as any)._plotRegistry.get('second').selection])).toEqual([2]);
});

test('names the picked layer in map:picking by its id, with two layers on one map', async ({ page }) => {
    await runSpec(page, {
        data: [area, blocks, zones],
        map: { layerRefs: [{ dataRef: 'blocks', isPick: true }, { dataRef: 'zones', title: 'Zones', isPick: true }] },
    });
    // autk-map reports a pick with the id of the layer picked: a feature of the titled layer, then one of the other.
    const reported = await page.evaluate(() => {
        const events: unknown[] = [];
        window.grammar.interactions.on('map:picking', (event) => { events.push(event); });
        const map = window.grammar.maps[0];
        map.events.emit('picking' as never, { selection: [2], layerId: 'Zones' } as never);
        map.events.emit('picking' as never, { selection: [1], layerId: 'blocks' } as never);
        return events;
    });
    expect(reported).toEqual([{ mapId: 0, layerId: 'Zones', selection: [2] }, { mapId: 0, layerId: 'blocks', selection: [1] }]);
});

test('forwards the picks of both maps of multi-map, each naming its map by its id, else its index', async ({ page }) => {
    // Both maps draw one table. The grammar kept one map per table, the last, and forwarded the picks of that map only.
    const picks = () => page.evaluate(() => {
        const events: unknown[] = [];
        window.grammar.interactions.on('map:picking', (event) => { events.push(event); });
        window.grammar.maps.forEach((map, index) =>
            map.events.emit('picking' as never, { selection: [index + 2], layerId: 'neighborhoods' } as never));
        return events;
    });
    await run(page, 'multi-map');
    expect(await page.evaluate(() => window.grammar.maps.length)).toBe(2);
    expect(await picks()).toEqual([
        { mapId: 0, layerId: 'neighborhoods', selection: [2] },
        { mapId: 1, layerId: 'neighborhoods', selection: [3] },
    ]);

    // A map with an id is named by it.
    const spec = await exampleSpec(page, 'multi-map');
    const [first, second] = spec.map as MapSpec[];
    await runSpec(page, { ...spec, map: [{ ...first, id: 'areas' }, second] });
    expect(await picks()).toEqual([
        { mapId: 'areas', layerId: 'neighborhoods', selection: [2] },
        { mapId: 1, layerId: 'neighborhoods', selection: [3] },
    ]);
});

test('selects in a linked plot only what is picked on its own layer', async ({ page }) => {
    await runSpec(page, {
        data: [area, blocks, zones],
        map: { id: 'm', layerRefs: [{ dataRef: 'blocks', isPick: true }, { dataRef: 'zones', title: 'Zones' }] },
        plot: { id: 'p', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'], events: ['click'] },
        links: [{ source: 'p', target: 'm', layer: 'Zones' }],
    });
    const selection = () => page.evaluate(() => [...(window.grammar as any)._plotRegistry.get('p').selection]);
    const pick = (layerId: string, ids: number[]) => page.evaluate(([layer, selected]) =>
        window.grammar.maps[0].events.emit('picking' as never, { selection: selected, layerId: layer } as never), [layerId, ids] as const);
    await pick('Zones', [3]);
    expect(await selection()).toEqual([3]);
    // A pick on the other layer of the map leaves the plot as it was.
    await pick('blocks', [1]);
    expect(await selection()).toEqual([3]);
});

test('draws each plot in its own target when the plot targets are a list', async ({ page }) => {
    const plots: PlotSpec[] = [
        { id: 'first', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'] },
        { id: 'second', dataRef: 'zones', mark: 'scatter', axis: ['v', 'id'] },
    ];
    const svgsIn = (id: string) => page.evaluate((target) => document.querySelectorAll(`#${target} svg`).length, id);

    // A list gives plot i the target i. (With one target, a later plot replaces the earlier one.)
    await runSpec(page, { data: [area, zones], plot: plots }, 'each');
    expect(await svgsIn('plot0')).toBe(1);
    expect(await svgsIn('plot1')).toBe(1);
});

test('refuses two plots known by one name: two of a table without ids, or an id that is the dataRef of another plot', async ({ page }) => {
    // A plot without an id is known by its dataRef. The second such plot of a table replaced the first in the registry,
    // so links, events and calls reached only the second.
    const plot = { mark: 'scatter' as const, axis: ['id', 'v'] };
    await expect(runSpec(page, { data: [area, zones], plot: [{ ...plot, dataRef: 'zones' }, { ...plot, dataRef: 'zones' }] }, 'each'))
        .rejects.toThrow('Two plots of the table "zones" have no id; give each plot an id.');
    await expect(runSpec(page, { data: [area, zones, blocks], plot: [{ ...plot, dataRef: 'zones' }, { ...plot, id: 'zones', dataRef: 'blocks' }] }, 'each'))
        .rejects.toThrow('A plot\'s id "zones" is the dataRef of a plot without an id; give each plot an id.');
    await expect(runSpec(page, { data: [area, zones, blocks], plot: [{ ...plot, id: 'blocks', dataRef: 'zones' }, { ...plot, dataRef: 'blocks' }] }, 'each'))
        .rejects.toThrow('A plot\'s id "blocks" is the dataRef of a plot without an id; give each plot an id.');

    // With an id each, both draw and both are known.
    const { plotSvgs } = await runSpec(page, {
        data: [area, zones],
        plot: [{ ...plot, id: 'one', dataRef: 'zones' }, { ...plot, id: 'two', dataRef: 'zones' }],
    }, 'each');
    expect(plotSvgs).toBe(2);
    expect(await page.evaluate(() => [...(window.grammar as any)._plotRegistry.keys()])).toEqual(['one', 'two']);
});

test('refuses two views with one id, and links that name nothing', async ({ page }) => {
    const views = {
        data: [area, zones],
        map: { id: 'zmap', layerRefs: [{ dataRef: 'zones', title: 'Zones' }] },
        plot: { id: 'sc', dataRef: 'zones', mark: 'scatter' as const, axis: ['id', 'v'], events: ['click' as const] },
    };
    await expect(runSpec(page, { ...views, plot: { ...views.plot, id: 'zmap' } })).rejects.toThrow('Two maps or plots have the id "zmap"');
    await expect(runSpec(page, { ...views, links: [{ source: 'nope', target: 'zmap' }] })).rejects.toThrow('Link source "nope" is not the id');
    await expect(runSpec(page, { ...views, links: [{ source: 'sc', target: 'nope' }] })).rejects.toThrow('Link target "nope" is not the id of a map');
    await expect(runSpec(page, { ...views, links: [{ source: 'sc', target: 'zmap', layer: 'nope' }] })).rejects.toThrow('has no layer "nope"');
    // A link without a layer needs the map to draw the plot's table.
    await expect(runSpec(page, {
        ...views,
        map: { id: 'zmap', layerRefs: [{ dataRef: 'paths' }] },
        data: [area, zones, paths],
        links: [{ source: 'sc', target: 'zmap' }],
    })).rejects.toThrow('draws no layer of the table "zones"');
});

test('highlights a titled layer, and links it to a plot, by its data name', async ({ page }) => {
    await runSpec(page, {
        data: [area, zones],
        map: { layerRefs: [{ dataRef: 'zones', title: 'Zones', isPick: true }] },
        plot: { dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'], events: ['click'], mapRef: 'zones' },
    });
    const highlighted = async () => (await layerById(page)).Zones?.highlightedIds;
    expect((await layerById(page)).Zones).toMatchObject({ isPick: true, highlightedIds: [] });

    await page.evaluate(() => window.grammar.highlightOnMap('zones', [1, 2]));
    expect(await highlighted()).toEqual([1, 2]);
    await page.evaluate(() => window.grammar.clearHighlightOnMap('zones'));
    expect(await highlighted()).toEqual([]);
    // The plot's mapRef names the table, so a selection in the plot lands on the titled layer.
    await page.evaluate(() => window.grammar.setPlotSelection('zones', [3]));
    expect(await highlighted()).toEqual([3]);
    await page.evaluate(() => window.grammar.clearHighlightOnPlot('zones'));
    expect(await highlighted()).toEqual([]);

    const clicked = await page.evaluate(() => {
        const mark = document.querySelector('#plot .autkMark') as Element & { __data__?: { autkIds?: number[] } };
        mark.dispatchEvent(new MouseEvent('click'));
        return mark.__data__?.autkIds;
    });
    expect(clicked).toEqual([expect.any(Number)]);
    expect(await highlighted()).toEqual(clicked);
});

test('loads a GeoJSON whose features include null geometries: the map draws the others, and the plot counts every row', async ({ page }) => {
    // GeoJSON allows a null geometry, which autk-db refuses: its loader reads the layer's type off the first feature
    // ("First feature has no geometry or geometry type") and parses every feature's geometry as GeoJSON. So a GeoJSON
    // source with such a feature failed to load.
    type Mark = Element & { __data__?: { name?: string; autkIds?: number[] } };
    const point = (i: number) => ({ type: 'Point' as const, coordinates: [-73.985 + i * 0.002, 40.75 + i * 0.001] });
    for (const nulls of [['c'], ['a', 'c']]) {
        const features = ['a', 'b', 'c', 'd', 'e'].map((name, i) => ({
            type: 'Feature' as const,
            properties: { name, v: i * 10, w: 40 - i * 10 },
            geometry: nulls.includes(name) ? null : point(i),
        }));
        await runSpec(page, {
            data: [{ type: 'geojson', outputTableName: 'spots', geojsonObject: { type: 'FeatureCollection', features } }],
            map: { id: 'm', layerRefs: [{ dataRef: 'spots', title: 'Spots' }] },
            plot: { id: 'p', dataRef: 'spots', mark: 'scatter', axis: ['v', 'w'], events: ['brush'] },
            links: [{ source: 'p', target: 'm' }],
        });
        // The map draws the points of the rows with one, read as points though the first row has none.
        expect((await layerById(page)).Spots.type, `null geometries on ${nulls}`).toBe('points');
        const drawn = (await page.evaluate(() => window.drawnRows('map0', 'Spots'))).map((row) => row?.name);
        expect([...drawn].sort(), `null geometries on ${nulls}`).toEqual(['a', 'b', 'c', 'd', 'e'].filter((name) => !nulls.includes(name)));
        // The plot counts every row.
        const marks = await page.evaluate(() => [...document.querySelectorAll('#plot .autkMark')]
            .map((mark) => ({ name: (mark as Mark).__data__?.name, ids: (mark as Mark).__data__?.autkIds ?? [] })));
        expect(marks.map((mark) => mark.name).sort(), `null geometries on ${nulls}`).toEqual(['a', 'b', 'c', 'd', 'e']);
        // And a brush on d and e lights d and e.
        const brushed = marks.filter((mark) => mark.name === 'd' || mark.name === 'e').flatMap((mark) => mark.ids);
        await page.evaluate((ids) => (window.grammar as any)._plotRegistry.get('p').events.emit('brush', { selection: ids }), brushed);
        const lit = (await layerById(page)).Spots.highlightedIds ?? [];
        expect(lit.map((position) => drawn[position]).sort(), `null geometries on ${nulls}`).toEqual(['d', 'e']);
    }
});

test('highlights every map that draws a table, or the one a map key names, and links a plot to each', async ({ page }) => {
    // The grammar kept one map per table, the last: the first map's layer was never found, lit or linked.
    await runSpec(page, {
        data: [area, zones],
        map: [
            { id: 'left', layerRefs: [{ dataRef: 'zones', title: 'Zones' }] },
            { layerRefs: [{ dataRef: 'zones' }] },
        ],
        plot: { id: 'sc', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'], events: ['click'], mapRef: 'zones' },
    });
    const lit = async () => [(await layerById(page, 'map0')).Zones?.highlightedIds, (await layerById(page, 'map1')).zones?.highlightedIds];
    const selection = () => page.evaluate(() => [...(window.grammar as any)._plotRegistry.get('sc').selection]);

    // The lookups find the layer of each map, and a map key, an id or an index, names one map.
    expect(await page.evaluate(() => {
        const where = (layer?: { map: unknown; layerId: string }) =>
            layer ? [window.grammar.maps.indexOf(layer.map as never), layer.layerId] : null;
        return {
            all: window.grammar.mapLayers('zones').map(where),
            last: where(window.grammar.mapLayer('zones')),
            byId: where(window.grammar.mapLayer('zones', 'left')),
            byIndex: where(window.grammar.mapLayer('zones', 1)),
            missing: where(window.grammar.mapLayer('zones', 'right')),
        };
    })).toEqual({ all: [[0, 'Zones'], [1, 'zones']], last: [1, 'zones'], byId: [0, 'Zones'], byIndex: [1, 'zones'], missing: null });

    // A highlight reaches both maps and selects in the plot, and a map key keeps it to one map.
    await page.evaluate(() => window.grammar.highlightOnMap('zones', [1, 2]));
    expect(await lit()).toEqual([[1, 2], [1, 2]]);
    expect(await selection()).toEqual([1, 2]);
    await page.evaluate(() => window.grammar.highlightOnMap('zones', [3], 1));
    expect(await lit()).toEqual([[1, 2], [3]]);
    await page.evaluate(() => window.grammar.clearHighlightOnMap('zones', 'left'));
    expect(await lit()).toEqual([[], [3]]);

    // The plot's mapRef links it to the layer of each map: its selection lights both, or the map a key names.
    await page.evaluate(() => window.grammar.setPlotSelection('sc', [0]));
    expect(await lit()).toEqual([[0], [0]]);
    await page.evaluate(() => window.grammar.setPlotSelection('sc', [2], 'left'));
    expect(await lit()).toEqual([[2], [0]]);
    await page.evaluate(() => window.grammar.clearHighlightOnPlot('sc', 1));
    expect(await lit()).toEqual([[2], []]);
    await page.evaluate(() => window.grammar.clearHighlightOnPlot('sc'));
    expect(await lit()).toEqual([[], []]);

    // A pick on the first map's layer selects in the plot too.
    await page.evaluate(() => window.grammar.maps[0].events.emit('picking' as never, { selection: [3], layerId: 'Zones' } as never));
    expect(await selection()).toEqual([3]);

    // A link names its map: the plot's selection lights that map's layer only, though the other map draws the table too.
    await runSpec(page, {
        data: [area, zones],
        map: [{ id: 'left', layerRefs: [{ dataRef: 'zones', title: 'Zones' }] }, { layerRefs: [{ dataRef: 'zones' }] }],
        plot: { id: 'sc', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'], events: ['click'] },
        links: [{ source: 'sc', target: 'left' }],
    });
    await page.evaluate(() => window.grammar.setPlotSelection('sc', [1]));
    expect(await lit()).toEqual([[1], []]);
});

test('links a plot and a map by the rows each drew, though the map draws nothing for a row with no geometry', async ({ page }) => {
    // Five points, a to e, as the host hands them; c has an empty geometry. The plot draws all five, in that order. The
    // map draws autk-db's export, and a points layer has no position for a row it draws nothing for, so from d on a
    // position is another row in each view. A link passed positions as they were, so a brush on d and e lit e and
    // nothing, and a pick on d selected c. (A polygon layer keeps a position for such a row, one that draws nothing.)
    const point = (i: number) => ({ type: 'Point' as const, coordinates: [-73.985 + i * 0.002, 40.75 + i * 0.001] });
    const features = ['a', 'b', 'c', 'd', 'e'].map((name, i) => ({
        type: 'Feature' as const,
        properties: { name, v: i * 10, w: 40 - i * 10 },
        geometry: name === 'c' ? { type: 'GeometryCollection' as const, geometries: [] } : point(i),
    }));
    await runSpec(page, {
        data: [{ type: 'geojson', outputTableName: 'spots', geojsonObject: { type: 'FeatureCollection', features } }],
        map: { id: 'm', layerRefs: [{ dataRef: 'spots', title: 'Spots' }] },
        plot: { id: 'p', dataRef: 'spots', mark: 'scatter', axis: ['v', 'w'], events: ['brush'] },
        links: [{ source: 'p', target: 'm' }],
    });
    type Mark = Element & { __data__?: { name?: string; autkIds?: number[] } };
    const marks = () => page.evaluate(() => [...document.querySelectorAll('#plot .autkMark')]
        .map((mark) => ({ name: (mark as Mark).__data__?.name, ids: (mark as Mark).__data__?.autkIds ?? [] })));
    // What the map draws at each position, read from what autk-map was handed: the four points, not c.
    expect((await layerById(page)).Spots.type).toBe('points');
    const drawn = (await page.evaluate(() => window.drawnRows('map0', 'Spots'))).map((row) => row?.name);
    expect([...drawn].sort()).toEqual(['a', 'b', 'd', 'e']);
    expect((await marks()).map((mark) => mark.name).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    // So d is at one position in the plot and another on the map.
    expect(drawn.indexOf('d')).not.toBe((await marks()).find((mark) => mark.name === 'd')!.ids[0]);

    // A brush on the marks of d and e lights exactly the points d and e.
    const brushed = (await marks()).filter((mark) => mark.name === 'd' || mark.name === 'e').flatMap((mark) => mark.ids);
    await page.evaluate((ids) => (window.grammar as any)._plotRegistry.get('p').events.emit('brush', { selection: ids }), brushed);
    const lit = (await layerById(page)).Spots.highlightedIds ?? [];
    expect(lit.map((position) => drawn[position]).sort()).toEqual(['d', 'e']);

    // A pick on the point d selects the mark of d.
    await page.evaluate((position) => window.grammar.maps[0].events.emit('picking' as never, { selection: [position], layerId: 'Spots' } as never), drawn.indexOf('d'));
    const selection: number[] = await page.evaluate(() => [...(window.grammar as any)._plotRegistry.get('p').selection]);
    expect((await marks()).filter((mark) => mark.ids.some((id) => selection.includes(id))).map((mark) => mark.name)).toEqual(['d']);
});

test('draws a layer in its color, line width and outline', async ({ page }) => {
    await runSpec(page, {
        data: [area, zones, blocks, paths],
        map: {
            layerRefs: [
                { dataRef: 'zones', color: '#1f77b4', stroke: '#d62728', getFnv: 'v' },
                { dataRef: 'zones', title: 'Zones by value', color: '#1f77b4', getFnv: 'v', isColorMap: true },
                { dataRef: 'blocks', stroke: false },
                { dataRef: 'paths', color: '#2ca02c', width: 40 },
            ],
        },
    });
    const layers = await layerById(page);
    const blue = { r: 31, g: 119, b: 180, alpha: 1 };
    // A layer with a color is drawn in it rather than by its getFnv value, unless isColorMap is true.
    expect(layers.zones).toMatchObject({ color: blue, strokeColor: { r: 214, g: 39, b: 40, alpha: 1 } });
    expect(layers.zones.isColorMap).toBeFalsy();
    expect(layers.zones.showBorders).not.toBe(false);
    expect(layers['Zones by value']).toMatchObject({ color: blue, isColorMap: true });
    // stroke: false hides a polygon layer's outline.
    expect(layers.blocks.showBorders).toBe(false);
    // width is autk-map's polylinesWidth.
    expect(layers.paths).toMatchObject({ color: { r: 44, g: 160, b: 44, alpha: 1 }, polylinesWidth: 40 });
});

/** How many World Mercator (EPSG:3395) units a meter on the ground spans at a latitude: sec φ times sqrt(1 - e² sin² φ). */
function worldMercatorScale(lat: number): number {
    const phi = (lat * Math.PI) / 180;
    const s = 0.0818191908426215 * Math.sin(phi);
    return Math.sqrt(1 - s * s) / Math.cos(phi);
}

/**
 * How many pixels of the map on #map0 are drawn in `color`, `#rrggbb`, give or take 8 in each channel. The image is
 * attached to the test as `<name>.png`.
 */
async function pixelsIn(page: Page, color: string, name: string): Promise<number> {
    await page.waitForTimeout(1500);
    const dataUrl = await page.evaluate(() => window.readMap('map0'));
    const image = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    await test.info().attach(`${name}.png`, { body: image, contentType: 'image/png' });
    const png = PNG.sync.read(image);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    let count = 0;
    for (let i = 0; i < png.data.length; i += 4) {
        if (Math.abs(png.data[i] - r) <= 8 && Math.abs(png.data[i + 1] - g) <= 8 && Math.abs(png.data[i + 2] - b) <= 8) count++;
    }
    return count;
}

test('draws the points of a points layer with a pointSize radius in meters on the ground', async ({ page }) => {
    const red = '#d62728';
    const spotsWith = (options: Partial<MapLayerSpec>): UrbanSpec => ({
        data: [area, spots],
        map: { layerRefs: [{ dataRef: 'spots', color: red, ...options }] },
    });
    // The points lie around 40.755 degrees north, where a meter on the ground spans about 1.32 planar units.
    const scale = worldMercatorScale(40.755);

    // Without pointSize, autk-map's radius of 64 planar units, about 49 m on the ground here.
    await runSpec(page, spotsWith({}));
    expect((await layerById(page)).spots.pointSize).toBe(64);
    const byDefault = await pixelsIn(page, red, 'default discs');
    expect(byDefault, 'pixels of the default discs').toBeGreaterThan(100);

    // 12 m is about 16 planar units, a quarter of that radius, so the discs cover about a sixteenth of the pixels.
    await runSpec(page, spotsWith({ pointSize: 12 }));
    const small = await pixelsIn(page, red, '12 m discs');
    expect(small, 'pixels of the 12 m discs').toBeGreaterThan(0);
    expect(small * 4, `the 12 m discs cover ${small} pixels, the default ones ${byDefault}`).toBeLessThan(byDefault);
    expect((await layerById(page)).spots.pointSize).toBeCloseTo(12 * scale, 3);

    // 2 m, as for GPS fixes a meter or two apart. A polygon layer ignores pointSize, as it ignores width.
    await runSpec(page, {
        data: [area, zones, spots],
        map: { layerRefs: [{ dataRef: 'zones', pointSize: 2 }, { dataRef: 'spots', pointSize: 2 }] },
    });
    const layers = await layerById(page);
    expect(layers.spots.pointSize).toBeCloseTo(2 * scale, 4);
    expect(layers.zones.pointSize).toBeUndefined();
});

test('refuses a pointSize that is not a number of meters greater than 0, on any layer', async ({ page }) => {
    const refused = (dataRef: string, options: Record<string, unknown>, message: string) => expect(runSpec(page, {
        data: [area, zones, spots],
        map: { layerRefs: [{ dataRef, title: 'Named', ...options } as MapLayerSpec] },
    })).rejects.toThrow(`Layer "Named": ${message}`);
    await refused('spots', { pointSize: 0 }, 'pointSize must be a number of meters greater than 0, not 0.');
    await refused('spots', { pointSize: -2 }, 'pointSize must be a number of meters greater than 0, not -2.');
    await refused('spots', { pointSize: '2' }, 'pointSize must be a number of meters greater than 0, not "2".');
    await refused('zones', { pointSize: 0 }, 'pointSize must be a number of meters greater than 0, not 0.');
});

test('colors two vector layers with different value ranges over one colorMapRange', async ({ page }) => {
    const twoLayers = (options: Partial<MapLayerSpec>): UrbanSpec => ({
        data: [area, zones, lots],
        map: { layerRefs: [{ dataRef: 'zones', getFnv: 'v', ...options }, { dataRef: 'lots', getFnv: 'v', ...options }] },
    });
    const domains = async () => {
        const layers = await layerById(page);
        return { zones: layers.zones.domain, lots: layers.lots.domain };
    };
    // Each layer on its own scale: 20 is two thirds up the zones' scale and a third up the lots'.
    await runSpec(page, twoLayers({ colorMapInterpolator: scheme('interpolateViridis') }));
    expect(await domains()).toEqual({ zones: [0, 30], lots: [0, 60] });

    // One range on both. autk-map colors a vector layer on the GPU by a value's place between its domain's
    // ends, so a value has one color on both layers.
    await runSpec(page, twoLayers({ colorMapInterpolator: scheme('interpolateViridis'), colorMapRange: [0, 50] }));
    const labels = await page.evaluate((domain) => window.domainLabels(domain), [0, 50]);
    const layers = await layerById(page);
    for (const id of ['zones', 'lots'])
        expect(layers[id], id).toMatchObject({ isColorMap: true, interpolator: 'interpolateViridis', domain: [0, 50], labels });

    // Without a scheme too, in autk-map's own.
    await runSpec(page, twoLayers({ colorMapRange: [0, 50] }));
    expect(await domains()).toEqual({ zones: [0, 50], lots: [0, 50] });

    // A vector layer ignores colorMapCenter and colorMapReverse: its scale runs from the range's low to its
    // high, with autk-core's middle value on a diverging scheme.
    await runSpec(page, twoLayers({ colorMapInterpolator: scheme('interpolateRdBu'), colorMapRange: [-10, 50], colorMapCenter: 0, colorMapReverse: true }));
    expect(await domains()).toEqual({ zones: [-10, 20, 50], lots: [-10, 20, 50] });

    // A categorical scheme ignores the range: each value stays a category of its own.
    await runSpec(page, twoLayers({ colorMapInterpolator: scheme('schemeCategory10'), colorMapRange: [0, 50] }));
    const categories = await domains();
    expect({ zones: [...categories.zones ?? []].sort(), lots: [...categories.lots ?? []].sort() })
        .toEqual({ zones: ['0', '10', '20', '30'], lots: ['0', '20', '40', '60'] });
});

test('refuses a colorMapRange that is not [low, high] with low below high, with colorMapDomain, or around a center outside it', async ({ page }) => {
    const refused = (options: Record<string, unknown>, message: string) => expect(runSpec(page, {
        data: [area, zones],
        map: { layerRefs: [{ dataRef: 'zones', title: 'Zones', getFnv: 'v', ...options } as MapLayerSpec] },
    })).rejects.toThrow(`Layer "Zones": ${message}`);
    const shape = 'colorMapRange must hold two numbers, [low, high].';
    await refused({ colorMapRange: [0] }, shape);
    await refused({ colorMapRange: [0, 10, 20] }, shape);
    await refused({ colorMapRange: [0, '10'] }, shape);
    await refused({ colorMapRange: { low: 0, high: 10 } }, shape);
    await refused({ colorMapRange: [10, 0] }, 'colorMapRange low (10) must be less than high (0).');
    await refused({ colorMapRange: [5, 5] }, 'colorMapRange low (5) must be less than high (5).');
    await refused({ colorMapRange: [0, 10], colorMapDomain: ['0', '10'] }, 'set colorMapRange or colorMapDomain, not both.');
    await refused({ colorMapRange: [0, 10], colorMapCenter: 12 }, 'colorMapCenter (12) must lie within colorMapRange [0, 10].');
    await refused({ colorMapRange: [0, 10], colorMapCenter: -1 }, 'colorMapCenter (-1) must lie within colorMapRange [0, 10].');
});

// Raster layers: the gallery's 30 x 30 noise heatmap, drawn over its neighborhoods.
const scheme = (name: string) => name as unknown as ColorMapInterpolator;
function heatmapWith(options: Partial<MapLayerSpec>): UrbanSpec {
    return {
        ...heatmapGeojson,
        map: { layerRefs: [{ dataRef: 'neighborhoods' }, { dataRef: 'heatmap', getFnv: 'count.noise', ...options }] },
    };
}

async function heatmapLayer(page: Page, canvasId = 'map0', layerId = 'heatmap') {
    const layer = (await layerById(page, canvasId))[layerId];
    const { values } = await page.evaluate(({ canvasId, layerId }) => window.rasterCells(canvasId, layerId), { canvasId, layerId });
    const finite = values.filter(Number.isFinite);
    expect(finite.length).toBeGreaterThan(0);
    return { layer, finite, min: Math.min(...finite), max: Math.max(...finite) };
}

/**
 * Counts the cells with a value of a raster layer (the heatmap on map0 unless named) whose color is not the
 * scheme's color for that value over *domain*.
 */
function cellsOffScheme(
    page: Page, interpolator: string, domain: number[], canvasId = 'map0', layerId = 'heatmap',
): Promise<{ colored: number; off: number }> {
    return page.evaluate(({ interpolator, domain, canvasId, layerId }) => {
        const { values, rgba } = window.rasterCells(canvasId, layerId);
        let colored = 0;
        let off = 0;
        values.forEach((value, i) => {
            if (!Number.isFinite(value)) return;
            colored++;
            const c = window.schemeColor(value, interpolator, domain);
            if (rgba[i * 4] !== c.r || rgba[i * 4 + 1] !== c.g || rgba[i * 4 + 2] !== c.b) off++;
        });
        return { colored, off };
    }, { interpolator, domain, canvasId, layerId });
}

function expectDomain(actual: Array<number | string> | undefined, expected: number[]) {
    expect(actual?.length, `domain ${JSON.stringify(actual)}`).toBe(expected.length);
    expected.forEach((value, i) => expect(Number(actual![i])).toBeCloseTo(value, 6));
}

test('colors a raster in its scheme, cells and legend labels', async ({ page }) => {
    await runSpec(page, heatmapWith({ colorMapInterpolator: scheme('interpolateViridis') }));
    const { layer, min, max } = await heatmapLayer(page);
    expect(min).toBeLessThan(max);
    expect(layer.interpolator).toBe('interpolateViridis');
    expect(layer.domain).toEqual([min, max]);
    const labels = await page.evaluate((domain) => window.domainLabels(domain), [min, max]);
    expect(layer.labels).toEqual(labels);
    expect(await page.evaluate(() => window.legend())).toEqual({ title: 'heatmap', labels, visible: true });
    // Every cell with a value is colored on the scheme, not in autk-map's default reds.
    const cells = await cellsOffScheme(page, 'interpolateViridis', [min, max]);
    expect(cells.colored).toBeGreaterThan(0);
    expect(cells.off).toBe(0);

    // isColorMap: false hides the legend; the cells keep the scheme.
    await runSpec(page, heatmapWith({ colorMapInterpolator: scheme('interpolateViridis'), isColorMap: false }));
    const hidden = await heatmapLayer(page);
    expect(hidden.layer.isColorMap).toBe(false);
    expect((await page.evaluate(() => window.legend()))?.visible).toBe(false);
    expect((await cellsOffScheme(page, 'interpolateViridis', [hidden.min, hidden.max])).off).toBe(0);
});

/** The heatmap cells with a value, each as its value and the opacity autk-map gave it (0..255). */
function cellOpacities(page: Page): Promise<Array<{ value: number; alpha: number }>> {
    return page.evaluate(() => {
        const { values, rgba } = window.rasterCells('map0', 'heatmap');
        return values.flatMap((value, i) => (Number.isFinite(value) ? [{ value, alpha: rgba[i * 4 + 3] }] : []));
    });
}

test('passes a raster transfer function to autk-map', async ({ page }) => {
    // autk-map's default (far-zero around 0) draws cells near 0 faint or clear.
    await runSpec(page, heatmapWith({ colorMapInterpolator: scheme('interpolateViridis') }));
    const faint = await cellOpacities(page);
    expect(faint.some((cell) => cell.alpha < 255)).toBe(true);

    // opacityMin 1 draws every cell with a value fully opaque.
    await runSpec(page, heatmapWith({ colorMapInterpolator: scheme('interpolateViridis'), transferFunction: { opacityMin: 1, opacityMax: 1 } }));
    const opaque = await cellOpacities(page);
    expect(opaque.length).toBe(faint.length);
    expect(opaque.filter((cell) => cell.alpha !== 255)).toEqual([]);
    expect((await cellsOffScheme(page, 'interpolateViridis', (await heatmapLayer(page)).layer.domain as number[])).off).toBe(0);

    // linear mode from 0.2: the lowest value is drawn at 20% opacity, the highest at 100%.
    await runSpec(page, heatmapWith({ transferFunction: { mode: 'linear', opacityMin: 0.2, opacityMax: 1 } }));
    const linear = await cellOpacities(page);
    const lowest = Math.min(...linear.map((cell) => cell.value));
    const highest = Math.max(...linear.map((cell) => cell.value));
    expect(new Set(linear.filter((cell) => cell.value === lowest).map((cell) => cell.alpha))).toEqual(new Set([51]));
    expect(new Set(linear.filter((cell) => cell.value === highest).map((cell) => cell.alpha))).toEqual(new Set([255]));
});

test('centers and reverses a raster color scale', async ({ page }) => {
    // Centered: from the center less the farthest value's distance to it, to the center plus that distance.
    await runSpec(page, heatmapWith({ colorMapInterpolator: scheme('interpolateRdBu'), colorMapCenter: 25 }));
    const centered = await heatmapLayer(page);
    const reach = Math.max(...centered.finite.map((v) => Math.abs(v - 25)));
    expectDomain(centered.layer.domain, [25 - reach, 25, 25 + reach]);
    const centeredDomain = centered.layer.domain as number[];
    expect(centered.layer.labels).toEqual(await page.evaluate((d) => window.domainLabels(d), centeredDomain));
    expect((await page.evaluate(() => window.legend()))?.labels).toEqual(centered.layer.labels);
    expect((await cellsOffScheme(page, 'interpolateRdBu', centeredDomain)).off).toBe(0);

    // Reversed: the scheme runs from the highest value to the lowest, so the highest cell takes its first color.
    await runSpec(page, heatmapWith({ colorMapInterpolator: scheme('interpolateViridis'), colorMapReverse: true }));
    const reversed = await heatmapLayer(page);
    expect(reversed.layer.domain).toEqual([reversed.max, reversed.min]);
    expect((await cellsOffScheme(page, 'interpolateViridis', [reversed.max, reversed.min])).off).toBe(0);
    const { highest, first } = await page.evaluate((max) => {
        const { values, rgba } = window.rasterCells('map0', 'heatmap');
        const i = values.indexOf(max);
        return { highest: rgba.slice(i * 4, i * 4 + 3), first: window.schemeColor(0, 'interpolateViridis', [0, 1]) };
    }, reversed.max);
    expect(highest).toEqual([first.r, first.g, first.b]);

    // Both, as a difference map draws: centered on 0 and reversed, so on RdBu red is the highest.
    await runSpec(page, heatmapWith({ colorMapInterpolator: scheme('interpolateRdBu'), colorMapCenter: 0, colorMapReverse: true }));
    const difference = await heatmapLayer(page);
    const far = Math.max(...difference.finite.map((v) => Math.abs(v)));
    expectDomain(difference.layer.domain, [far, 0, -far]);
    expect((await cellsOffScheme(page, 'interpolateRdBu', difference.layer.domain as number[])).off).toBe(0);
});

// The same points counted within 400 m of each cell instead of 1000 m: the same grid, with lower counts.
const nearHeatmap: DataSourceSpec = {
    type: 'heatmap',
    joinDataRef: 'noise',
    near: { distance: 400 },
    outputTableName: 'heatmap_near',
    grid: { rows: 30, columns: 30 },
    groupBy: [{ column: 'Unique Key', aggregateFn: 'count' }],
};

/** The heatmap on map0 and the 400 m heatmap on map1, both on Viridis, with *options*. */
function twoHeatmapsWith(options: Partial<MapLayerSpec>): UrbanSpec {
    const layer = (dataRef: string): MapLayerSpec => ({ dataRef, getFnv: 'count.noise', colorMapInterpolator: scheme('interpolateViridis'), ...options });
    return {
        data: [...(heatmapGeojson.data ?? []), nearHeatmap],
        map: [{ layerRefs: [layer('heatmap')] }, { layerRefs: [layer('heatmap_near')] }],
    };
}

/** A raster layer's colors: each cell value's RGB as `r,g,b`, and the opacity (0..255) of every cell with a value. */
function rasterColors(page: Page, canvasId: string, layerId: string): Promise<{ rgb: Record<string, string>; alphas: number[] }> {
    return page.evaluate(({ canvasId, layerId }) => {
        const { values, rgba } = window.rasterCells(canvasId, layerId);
        const rgb: Record<string, string> = {};
        const alphas: number[] = [];
        values.forEach((value, i) => {
            if (!Number.isFinite(value)) return;
            rgb[String(value)] = rgba.slice(i * 4, i * 4 + 3).join(',');
            alphas.push(rgba[i * 4 + 3]);
        });
        return { rgb, alphas };
    }, { canvasId, layerId });
}

/** The values two rasters both hold that they color differently, and how many values they both hold. */
function sharedValues(a: Record<string, string>, b: Record<string, string>) {
    const shared = Object.keys(a).filter((value) => value in b);
    return { count: shared.length, colorsDiffer: shared.filter((value) => a[value] !== b[value]) };
}

test('colors two rasters with different value ranges alike over one colorMapRange', async ({ page }) => {
    // Each raster on its own scale: a count both rasters hold is colored differently on the two maps.
    await runSpec(page, twoHeatmapsWith({}));
    const wide = await heatmapLayer(page, 'map0', 'heatmap');
    const near = await heatmapLayer(page, 'map1', 'heatmap_near');
    expect(near.max).toBeLessThan(wide.max - 1);
    expect(wide.layer.domain).toEqual([wide.min, wide.max]);
    expect(near.layer.domain).toEqual([near.min, near.max]);
    const apart = sharedValues((await rasterColors(page, 'map0', 'heatmap')).rgb, (await rasterColors(page, 'map1', 'heatmap_near')).rgb);
    expect(apart.colorsDiffer.length).toBeGreaterThan(0);

    // One range on both, ending between their highest counts, with every cell opaque as Curio draws rasters:
    // both maps color each value over the range, so a count has one color on both.
    const range: [number, number] = [0, Math.round((near.max + wide.max) / 2)];
    await runSpec(page, twoHeatmapsWith({ colorMapRange: range, transferFunction: { opacityMin: 1, opacityMax: 1 } }));
    const labels = await page.evaluate((domain) => window.domainLabels(domain), range);
    for (const [canvasId, layerId] of [['map0', 'heatmap'], ['map1', 'heatmap_near']]) {
        const { layer } = await heatmapLayer(page, canvasId, layerId);
        expect(layer.domain, layerId).toEqual(range);
        expect(layer.labels, layerId).toEqual(labels);
        expect((await cellsOffScheme(page, 'interpolateViridis', range, canvasId, layerId)).off, layerId).toBe(0);
    }
    const wideColors = await rasterColors(page, 'map0', 'heatmap');
    const nearColors = await rasterColors(page, 'map1', 'heatmap_near');
    const together = sharedValues(wideColors.rgb, nearColors.rgb);
    expect(together.count).toBeGreaterThan(1);
    expect(together.colorsDiffer).toEqual([]);
    expect([...wideColors.alphas, ...nearColors.alphas].filter((alpha) => alpha !== 255)).toEqual([]);
});

test('centers and reverses a raster color scale within its colorMapRange, and draws a range without a scheme', async ({ page }) => {
    // With a center: from the range's low through the center to its high, whatever the cell values.
    await runSpec(page, heatmapWith({ colorMapInterpolator: scheme('interpolateRdBu'), colorMapRange: [-40, 160], colorMapCenter: 20 }));
    const centered = await heatmapLayer(page);
    expect(centered.layer.domain).toEqual([-40, 20, 160]);
    expect(centered.layer.labels).toEqual(await page.evaluate((domain) => window.domainLabels(domain), [-40, 20, 160]));
    expect((await page.evaluate(() => window.legend()))?.labels).toEqual(centered.layer.labels);
    expect((await cellsOffScheme(page, 'interpolateRdBu', [-40, 20, 160])).off).toBe(0);

    // Reversed: from the range's high through the center to its low.
    await runSpec(page, heatmapWith({ colorMapInterpolator: scheme('interpolateRdBu'), colorMapRange: [-40, 160], colorMapCenter: 20, colorMapReverse: true }));
    expect((await heatmapLayer(page)).layer.domain).toEqual([160, 20, -40]);
    expect((await cellsOffScheme(page, 'interpolateRdBu', [160, 20, -40])).off).toBe(0);

    // Reversed without a center, on a sequential scheme: from the range's high to its low.
    await runSpec(page, heatmapWith({ colorMapInterpolator: scheme('interpolateViridis'), colorMapRange: [5, 50], colorMapReverse: true }));
    expect((await heatmapLayer(page)).layer.domain).toEqual([50, 5]);
    expect((await cellsOffScheme(page, 'interpolateViridis', [50, 5])).off).toBe(0);

    // A range alone colors the raster over it in autk-map's own scheme, and shows its legend.
    await runSpec(page, heatmapWith({ colorMapRange: [0, 100] }));
    const plain = await heatmapLayer(page);
    expect(plain.layer).toMatchObject({ isColorMap: true, domain: [0, 100] });
    expect((await page.evaluate(() => window.legend()))?.visible).toBe(true);
    expect((await cellsOffScheme(page, plain.layer.interpolator, [0, 100])).off).toBe(0);
});

test('loads a GeoTIFF as a raster layer', async ({ page }) => {
    // Like heatmaps, rasters are drawn on the map but not listed in the summary's tables. A raster does not frame
    // the map, so a vector layer over the same area does.
    const area = { type: 'Polygon' as const, coordinates: [[[-43.2, -22.95], [-43.0, -22.95], [-43.0, -22.8], [-43.2, -22.8], [-43.2, -22.95]]] };
    await runSpec(page, {
        data: [
            { type: 'geotiff', outputTableName: 'lst', geotiffFileUrl: '/data/niteroi_lst_verao_2001_2024.tif' },
            { type: 'geojson', outputTableName: 'area', geojsonObject: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: area, properties: {} }] } },
        ],
        map: { layerRefs: [{ dataRef: 'area' }, { dataRef: 'lst', colorMapInterpolator: scheme('interpolateYlOrRd') }] },
    });
    const layers = await page.evaluate(() => window.mapLayers('map0'));
    expect(layers.map((layer) => layer.type)).toEqual(['polygons', 'raster']);
    expect(layers[1].domain).toEqual([expect.any(Number), expect.any(Number)]);
    await expectDrawn(page, 'map0');
});

test('draws the band of a raster that getFnv names, refuses one that names none of several, and draws a raster of one band', async ({ page }) => {
    // The temperature GeoTIFF holds 24 bands, one a year from 2001 to 2024. A name that matched no band drew band_1,
    // 2001's, without a word.
    const area = { type: 'Polygon' as const, coordinates: [[[-43.2, -22.95], [-43.0, -22.95], [-43.0, -22.8], [-43.2, -22.8], [-43.2, -22.95]]] };
    const temperatureBy = (getFnv: string): UrbanSpec => ({
        data: [
            { type: 'geotiff', outputTableName: 'lst', geotiffFileUrl: '/data/niteroi_lst_verao_2001_2024.tif' },
            { type: 'geojson', outputTableName: 'area', geojsonObject: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: area, properties: {} }] } },
        ],
        map: { layerRefs: [{ dataRef: 'area' }, { dataRef: 'lst', title: 'Temperature', getFnv }] },
    });
    const bands = Array.from({ length: 24 }, (_, i) => `band_${i + 1}`).join(', ');
    await expect(runSpec(page, temperatureBy('band_25')))
        .rejects.toThrow(`Layer "Temperature": getFnv "band_25" names none of its 24 bands: ${bands}.`);
    await expect(runSpec(page, temperatureBy('temperature.2024'))).rejects.toThrow('getFnv "temperature.2024" names none of its 24 bands');

    // A band by its id: the layer draws 2024's values, not 2001's.
    await runSpec(page, temperatureBy('band_24'));
    const drawn = await page.evaluate(() => window.rasterCells('map0', 'Temperature').values);
    expect(drawn).toEqual(await page.evaluate(() => window.handedBand('map0', 'Temperature', 'band_24')));
    expect(drawn).not.toEqual(await page.evaluate(() => window.handedBand('map0', 'Temperature', 'band_1')));

    // A heatmap of one band draws it, whatever getFnv names: autk-db labels it count_noise.
    await runSpec(page, heatmapWith({ getFnv: 'sum.noise' }));
    await heatmapLayer(page);
});

test('draws a GeoJSON polygon layer as parks when layerType says so', async ({ page }) => {
    const square = { type: 'Polygon' as const, coordinates: [[[-74.01, 40.70], [-74.0, 40.70], [-74.0, 40.71], [-74.01, 40.71], [-74.01, 40.70]]] };
    await runSpec(page, {
        data: [{
            type: 'geojson', outputTableName: 'g', layerType: 'parks',
            geojsonObject: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: square, properties: {} }] },
        }],
        map: { layerRefs: [{ dataRef: 'g' }] },
    });
    expect((await page.evaluate(() => window.mapLayers('map0'))).map((layer) => layer.type)).toEqual(['parks']);
});

test('writes a compute pass into a new table and leaves its source alone', async ({ page }) => {
    const { tables } = await runSpec(page, {
        data: [{ type: 'geojson', geojsonFileUrl: '/data/mnt_neighs.geojson', outputTableName: 'neighborhoods' }],
        compute: [{
            dataRef: 'neighborhoods',
            attributes: { x: 'shape_area', y: 'shape_leng' },
            outputColumnName: 'result',
            wgslFunction: 'return (4.0 * 3.1415927 * x) / (y * y);',
            outputTableName: 'compactness',
        }],
        map: { layerRefs: [{ dataRef: 'compactness', getFnv: 'compute.result', getFnvType: 'quantitative', defaultFnv: 0 }] },
    });
    expect(tables.compactness.features).toBe(tables.neighborhoods.features);
    expect(await page.evaluate(() => window.valueAt('compactness', 0, 'compute.result'))).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.valueAt('neighborhoods', 0, 'compute.result'))).toBeUndefined();
    expect((await page.evaluate(() => window.mapLayers('map0'))).map((layer) => layer.type)).toEqual(['polygons']);
    await expectDrawn(page, 'map0');
});

test('runs a render compute pass into a new table', async ({ page }) => {
    const { tables } = await runSpec(page, {
        ...boxSpec({ bbox: BOX }),
        compute: [{
            type: 'render',
            outputTableName: 'visibility',
            layers: [{ id: 'buildings', dataRef: 'box_buildings', type: 'buildings' }, { id: 'roads', dataRef: 'box_roads', type: 'roads' }],
            viewpoints: { dataRef: 'box_buildings', sampling: { directions: 4 } },
            aggregation: { type: 'classes', includeBackground: true },
            tileSize: 64,
        }],
        map: { layerRefs: [{ dataRef: 'box_surface' }, { dataRef: 'visibility' }] },
    });
    expect(tables.visibility.features).toBe(tables.box_buildings.features);
    const render = await page.evaluate(() => window.valueAt('visibility', 0, 'compute.render'));
    expect(render, 'compute.render of the first viewpoint').toMatchObject({ sampleCount: 4, classes: { buildings: expect.any(Number), background: expect.any(Number) } });
    expect(await page.evaluate(() => window.valueAt('box_buildings', 0, 'compute.render'))).toBeUndefined();
    expect((await page.evaluate(() => window.mapLayers('map0'))).map((layer) => [layer.id, layer.type])).toEqual([['box_surface', 'surface'], ['visibility', 'buildings']]);
});

test('draws the windows of a building-windows render pass as points', async ({ page }) => {
    const { tables } = await runSpec(page, {
        ...boxSpec({ bbox: BOX }),
        compute: [{
            type: 'render',
            outputTableName: 'windows',
            layers: [{ id: 'buildings', dataRef: 'box_buildings', type: 'buildings' }],
            viewpoints: { dataRef: 'box_buildings', strategy: { type: 'building-windows', floors: 1 } },
            aggregation: { type: 'classes', includeBackground: true },
            tileSize: 8,
        }],
        map: { layerRefs: [{ dataRef: 'box_surface' }, { dataRef: 'windows' }] },
    });
    // The result is one point per window, each looking out from its facade and 30 degrees to either side.
    expect(tables.windows.features).toBeGreaterThan(tables.box_buildings.features);
    const [first] = await page.evaluate(() => window.featureExtents('windows'));
    expect([first[0], first[1]], 'the first window is a point').toEqual([first[2], first[3]]);
    expect(await page.evaluate(() => window.valueAt('windows', 0, 'compute.render.sampleCount'))).toBe(3);
    // So the map draws it as points, though the viewpoints table is drawn as buildings.
    expect((await page.evaluate(() => window.mapLayers('map0'))).map((layer) => [layer.id, layer.type])).toEqual([['box_surface', 'surface'], ['windows', 'points']]);
});

test('refuses a points layer in a render pass, and names the layer', async ({ page }) => {
    // autk-compute would skip it with only a warning. The schema refuses the type too.
    await expect(runSpec(page, {
        data: [area, zones, spots],
        compute: [{
            type: 'render',
            outputTableName: 'seen',
            layers: [{ id: 'zones', dataRef: 'zones', type: 'polygons' }, { id: 'spots', dataRef: 'spots', type: 'points' as never }],
            viewpoints: { dataRef: 'spots' },
            aggregation: { type: 'classes' },
        }],
    })).rejects.toThrow('Render pass "seen": layer "spots" has the type "points", which a render pass cannot draw.');
});

test('refuses collect in a heatmap groupBy, naming the heatmap, and builds the heatmap with count', async ({ page }) => {
    // collect lists the rows near a cell, and a cell holds one value. The schema refuses it, but a spec the schema never
    // checked reaches the adapter, which passed it on to autk-db.
    const heatmap = (aggregateFn: string) => ({
        type: 'heatmap', outputTableName: 'heat', joinDataRef: 'spots', near: { distance: 500 }, grid: { rows: 2, columns: 2 },
        groupBy: [{ column: 'id', aggregateFn }],
    }) as unknown as DataSourceSpec;
    await expect(runSpec(page, { data: [area, spots, heatmap('collect')] }))
        .rejects.toThrow('Heatmap "heat": aggregateFn "collect" lists the rows near a cell, and a cell holds one value; use sum, avg, count, min, max or weighted.');
    await runSpec(page, { data: [area, spots, heatmap('count')], map: { layerRefs: [{ dataRef: 'heat', getFnv: 'count.spots' }] } });
    expect((await mapLayers(page)).map((layer) => [layer.id, layer.type])).toEqual([['heat', 'raster']]);
});

test('accepts useCentroid on a heatmap', async ({ page }) => {
    const [neighborhoods, noise, heatmap] = heatmapGeojson.data!;
    const withNear = (near: object): UrbanSpec => ({
        ...heatmapGeojson,
        data: [neighborhoods, noise, { ...heatmap, near } as DataSourceSpec],
    });
    await runSpec(page, withNear({ distance: 1000 }));
    const byDefault = await heatmapLayer(page);
    await runSpec(page, withNear({ distance: 1000, useCentroid: true }));
    expect((await heatmapLayer(page)).finite).toEqual(byDefault.finite);
    await runSpec(page, withNear({ distance: 1000, useCentroid: false }));
    // Point rows have no extent, so the result matches; this checks that the option is accepted.
    expect((await heatmapLayer(page)).finite).toEqual(byDefault.finite);
});

test('builds a heatmap band with normalize, which autk-db 4.1.1 draws from the raw counts', async ({ page }) => {
    // This test encodes autk-db 4.1.1. urban-toolkit/autark#132 rescales a normalized band from 0 to 1 and adds _norm to
    // its label; once an autk-db with it is released, the `latest` leg fails here, and the test moves to those values.
    const [neighborhoods, noise, source] = heatmapGeojson.data!;
    const heatmap = source as HeatmapSourceSpec;
    await runSpec(page, heatmapGeojson);
    const raw = (await heatmapLayer(page)).finite;
    await runSpec(page, {
        ...heatmapGeojson,
        data: [neighborhoods, noise, { ...heatmap, groupBy: heatmap.groupBy!.map((group) => ({ ...group, normalize: true })) }],
    });
    const normalized = (await heatmapLayer(page)).finite;
    expect(Math.max(...raw), 'the busiest cell counts many complaints').toBeGreaterThan(1);
    expect(normalized).toEqual(raw);
});

test('saves the rows of a sql source as a table, drawn as its layerType says, or plotted without one', async ({ page }) => {
    const { tables } = await runSpec(page, {
        data: [
            area,
            zones,
            { type: 'sql', outputTableName: 'high', query: "SELECT * FROM zones WHERE CAST(properties->>'v' AS INTEGER) >= 20", layerType: 'polygons' },
            { type: 'sql', outputTableName: 'zone_values', query: "SELECT CAST(properties->>'id' AS INTEGER) AS id, CAST(properties->>'v' AS INTEGER) AS v FROM zones" },
        ],
        map: { layerRefs: [{ dataRef: 'zones' }, { dataRef: 'high', title: 'High', color: '#d62728' }] },
        plot: { dataRef: 'zone_values', mark: 'bar', axis: ['id', 'v'] },
    });
    // The two zones the query keeps, drawn as polygons on the map.
    expect(tables.high.features).toBe(2);
    expect((await page.evaluate(() => window.drawnRows('map0', 'High'))).map((row) => Number(row?.v)).sort((a, b) => a - b)).toEqual([20, 30]);
    expect((await layerById(page)).High.type).toBe('polygons');
    // A table without a layer type is not listed in data, and a plot draws its rows.
    expect(tables.zone_values).toBeUndefined();
    const bars = await page.evaluate(() => [...document.querySelectorAll('#plot rect.autkMark')]
        .map((bar) => (bar as Element & { __data__?: { id?: number; v?: number } }).__data__)
        .map((datum) => `${datum?.id} ${datum?.v}`));
    expect(bars.sort()).toEqual(['0 0', '1 10', '2 20', '3 30']);

    // autk-db runs a SELECT only, and the run names the source it refused.
    await expect(runSpec(page, { data: [area, zones, { type: 'sql', outputTableName: 'gone', query: 'DROP TABLE zones' }] }))
        .rejects.toThrow('SQL source "gone": Only SELECT queries are allowed for raw queries.');
});

test('replaces and updates the rows of a table with an update source, and the map and the plot draw them as they are now', async ({ page }) => {
    /** Each bar of the plot, as its two axes' values. */
    const bars = (axes: [string, string]) => page.evaluate((axes) => [...document.querySelectorAll('#plot rect.autkMark')]
        .map((bar) => (bar as Element & { __data__?: Record<string, unknown> }).__data__ ?? {})
        .map((datum) => `${datum[axes[0]]} ${datum[axes[1]]}`)
        .sort(), axes);

    // A table without a geometry, updated by month: February changes, and April, which matches no row, is added.
    const sales: DataSourceSpec = { type: 'csv', outputTableName: 'sales', csvObject: [['month', 'total'], ['Jan', 3], ['Feb', 5], ['Mar', 2]] };
    const salesPlot: PlotSpec = { dataRef: 'sales', mark: 'bar', axis: ['month', 'total'] };
    await runSpec(page, {
        data: [sales, { type: 'update', dataRef: 'sales', strategy: 'update', idColumn: 'month', jsonObject: [{ month: 'Feb', total: 9 }, { month: 'Apr', total: 4 }] }],
        plot: salesPlot,
    });
    expect(await bars(['month', 'total'])).toEqual(['Apr 4', 'Feb 9', 'Jan 3', 'Mar 2']);
    await runSpec(page, { data: [sales, { type: 'update', dataRef: 'sales', strategy: 'replace', jsonObject: [{ month: 'May', total: 7 }] }], plot: salesPlot });
    expect(await bars(['month', 'total'])).toEqual(['May 7']);

    // A table with a geometry, updated by a property with a feature of its own export, whose coordinates are the
    // workspace's: zone 2 takes the value 99.
    await runSpec(page, { data: [area, zones] });
    const exported = await page.evaluate(async () => (await window.grammar.data.zones).features);
    const changed = exported.filter((feature) => feature.properties?.id === 2).map((feature) => ({ ...feature, properties: { ...feature.properties, v: 99 } }));
    expect(changed).toHaveLength(1);
    await runSpec(page, {
        data: [area, zones, { type: 'update', dataRef: 'zones', strategy: 'update', idColumn: 'properties.id', geojsonObject: { type: 'FeatureCollection', features: changed } } as DataSourceSpec],
        map: { layerRefs: [{ dataRef: 'zones' }] },
        plot: { dataRef: 'zones', mark: 'bar', axis: ['id', 'v'] },
    });
    // The map draws the new value, and so does the plot, which no longer reads the rows the GeoJSON source loaded.
    expect((await page.evaluate(() => window.drawnRows('map0', 'zones'))).map((row) => `${row?.id} ${row?.v}`).sort()).toEqual(['0 0', '1 10', '2 99', '3 30']);
    expect(await bars(['id', 'v'])).toEqual(['0 0', '1 10', '2 99', '3 30']);

    // autk-db's refusal names the table.
    await expect(runSpec(page, { data: [area, zones, { type: 'update', dataRef: 'nowhere', strategy: 'replace', jsonObject: [{ v: 1 }] }] }))
        .rejects.toThrow('Update of "nowhere": Table nowhere not found.');
});

test('drops a table with a drop source, so data no longer lists it and a map no longer finds it', async ({ page }) => {
    const dropped: UrbanSpec = { data: [area, zones, blocks, { type: 'drop', dataRef: 'blocks' }] };
    const { tables } = await runSpec(page, { ...dropped, map: { layerRefs: [{ dataRef: 'zones' }] } });
    expect(Object.keys(tables).sort()).toEqual(['area', 'zones']);
    await expect(runSpec(page, { ...dropped, map: { layerRefs: [{ dataRef: 'blocks' }] } })).rejects.toThrow('Table blocks not found.');
    // A drop of a table the workspace does not hold is refused, rather than passed over.
    await expect(runSpec(page, { data: [area, zones, { type: 'drop', dataRef: 'block' }] }))
        .rejects.toThrow('Drop of "block": the default workspace holds no table of that name.');
});

test('sets the radius of a points layer with pointSize', async ({ page }) => {
    const points = { type: 'MultiPoint' as const, coordinates: [[-74.0, 40.7], [-73.99, 40.71]] };
    await runSpec(page, {
        data: [{ type: 'geojson', outputTableName: 'p', geojsonObject: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: points, properties: {} }] } }],
        map: { layerRefs: [{ dataRef: 'p', pointSize: 30 }] },
    });
    const [layer] = await page.evaluate(() => window.mapLayers('map0'));
    // 30 m on the ground, in planar units at the middle of the points, 40.705 degrees north.
    expect(layer.type).toBe('points');
    expect(layer.pointSize).toBeCloseTo(30 * worldMercatorScale(40.705), 3);
});

test('turns the camera around the point it looks at', async ({ page }) => {
    const spec = (camera?: object): UrbanSpec => ({
        data: [{ type: 'geojson', geojsonFileUrl: '/data/mnt_neighs.geojson', outputTableName: 'n' }],
        map: { layerRefs: [{ dataRef: 'n' }], ...(camera && { camera }) },
    });
    await runSpec(page, spec());
    const before = await page.evaluate(() => window.cameraState('map0'));

    await runSpec(page, spec({ zoom: 12, pitch: 60, bearing: 90 }));
    const after = await page.evaluate(() => window.cameraState('map0'));
    const distance = 10000 / 2 ** 2;
    // The same point is looked at, and the eye is `distance` away from it, tilted 60 degrees from the vertical.
    expect(after.lookAt[0]).toBeCloseTo(before.lookAt[0], 3);
    expect(after.lookAt[1]).toBeCloseTo(before.lookAt[1], 3);
    expect(after.eye[2]).toBeCloseTo(distance * Math.cos(Math.PI / 3), 3);
    // Bearing 90 looks east, so the eye is west of the point.
    expect(after.eye[0] - after.lookAt[0]).toBeCloseTo(-distance * Math.sin(Math.PI / 3), 3);
    expect(after.eye[1]).toBeCloseTo(after.lookAt[1], 3);
});

test("keeps the camera's up direction across its line of sight at any pitch below 90, and refuses a pitch of 90", async ({ page }) => {
    const spec = (camera: CameraSpec): UrbanSpec => ({ data: [area, zones], map: { camera, layerRefs: [{ dataRef: 'zones' }] } });
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const unit = (a: number[]) => a.map((value) => value / Math.sqrt(dot(a, a)));
    for (const pitch of [0, 55, 89.9]) {
        await runSpec(page, spec({ zoom: 12, pitch, bearing: 30 }));
        const view = await page.evaluate(() => {
            const camera = window.grammar.maps[0].camera;
            return {
                eye: camera.getEye(), lookAt: camera.getLookAt(), up: camera.getUp(), fovy: camera.getFovyRadians(),
                center: camera.getWorldRayDirection(0.5, 0.5), top: camera.getWorldRayDirection(0.5, 1),
            };
        });
        // autk-map's tilt, pan and zoom at the cursor move along the up direction, and take it to be across the line of
        // sight. Up to 5.0.0 it lay flat, along the bearing, so at a pitch of 55 it leaned 55 degrees into the line of sight.
        const sight = unit(view.lookAt.map((value, i) => value - view.eye[i]));
        expect(Math.abs(dot(unit(view.up), sight)), `pitch ${pitch}: up across the line of sight`).toBeLessThan(1e-5);
        expect(view.up[2], `pitch ${pitch}: up toward the sky`).toBeGreaterThanOrEqual(0);
        // So the ray through the top of the view, which a zoom there follows, leaves half the field of view above the
        // ray through its center (about 10 degrees rather than 22.5 at a pitch of 55 with the up lying flat).
        expect(Math.acos(Math.min(1, dot(unit(view.top), unit(view.center)))), `pitch ${pitch}: the top ray`).toBeCloseTo(view.fovy / 2, 4);
    }
    // At 90 the eye would sit on the ground, edge-on to the flat layers, and the map could not pan.
    await expect(runSpec(page, spec({ zoom: 12, pitch: 90 })))
        .rejects.toThrow('Map 0: camera.pitch must be at least 0 and less than 90 degrees, not 90');
});

test('raises a map on the heights of the raster band its terrain names, and refuses a terrain that is not a raster band', async ({ page }) => {
    // The 24 yearly bands of the Niteroi temperature GeoTIFF, from 2001 to 2024, as heights: each band is another ground.
    const area = { type: 'Polygon' as const, coordinates: [[[-43.2, -22.95], [-43.0, -22.95], [-43.0, -22.8], [-43.2, -22.8], [-43.2, -22.95]]] };
    const withTerrain = (terrain?: TerrainSpec): UrbanSpec => ({
        data: [
            { type: 'geojson', outputTableName: 'area', geojsonObject: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: area, properties: {} }] } },
            { type: 'geotiff', outputTableName: 'lst', geotiffFileUrl: '/data/niteroi_lst_verao_2001_2024.tif' },
        ],
        map: { layerRefs: [{ dataRef: 'area' }], ...(terrain && { terrain }) },
    });
    const terrainOf = () => page.evaluate(() => window.terrain('map0'));

    // Without a terrain the map is flat.
    await runSpec(page, withTerrain());
    expect(await terrainOf()).toBeNull();

    // The first band by default: the ground's heights run over that band's values.
    await runSpec(page, withTerrain({ dataRef: 'lst' }));
    const first = await terrainOf();
    expect(first).toMatchObject({ band: 'band_1', width: 22, height: 15 });
    expect(first!.minHeight).toBeCloseTo(first!.bandMin, 4);
    expect(first!.maxHeight).toBeCloseTo(first!.bandMax, 4);
    // autk-map fits the view to the ground: it looks at the middle of the raster.
    const [minX, minY, maxX, maxY] = first!.bounds;
    const { lookAt } = await page.evaluate(() => window.cameraState('map0'));
    expect(lookAt[0]).toBeCloseTo((minX + maxX) / 2, 0);
    expect(lookAt[1]).toBeCloseTo((minY + maxY) / 2, 0);
    await expectDrawn(page, 'map0');

    // A band by its id: 2024's ground, not 2001's.
    await runSpec(page, withTerrain({ dataRef: 'lst', band: 'band_24' }));
    const last = await terrainOf();
    expect(last).toMatchObject({ band: 'band_24' });
    expect(last!.minHeight).toBeCloseTo(last!.bandMin, 4);
    expect(last!.maxHeight).toBeCloseTo(last!.bandMax, 4);
    expect(last!.maxHeight).not.toBeCloseTo(first!.maxHeight, 1);

    // A band that names none of the 24, a table that is not a raster, and a name that is no table.
    await expect(runSpec(page, withTerrain({ dataRef: 'lst', band: 'band_25' })))
        .rejects.toThrow('Map 0: terrain band "band_25" names none of its 24 bands: band_1, band_2,');
    await expect(runSpec(page, withTerrain({ dataRef: 'area' })))
        .rejects.toThrow('Map 0: terrain dataRef "area" names a polygons table, and a terrain takes its heights from a raster table');
    await expect(runSpec(page, withTerrain({ dataRef: 'elevation' })))
        .rejects.toThrow(`Map 0: terrain dataRef "elevation" names no table of the map's workspace.`);
});

test('draws the second run of a reused grammar from its own table, though the first run loaded a GeoJSON table of that name', async ({ page }) => {
    // The grammar kept each GeoJSON table it loaded, which its plots read before the database, until the instance went
    // away: run again with a table of the same name from a CSV, a plot drew the first run's GeoJSON rows.
    const plot: PlotSpec = { id: 'tp', dataRef: 't', mark: 'scatter', axis: ['id', 'v'] };
    const values = () => page.evaluate(() => [...document.querySelectorAll('#plot .autkMark')]
        .map((mark) => Number((mark as Element & { __data__?: { v?: number } }).__data__?.v))
        .sort((a, b) => a - b));
    await runSpec(page, { data: [area, squares('t', 40.75)], plot });
    expect(await values()).toEqual([0, 10, 20, 30]);

    // The same AutkGrammar, now with t from a CSV of three points.
    await page.evaluate((spec) => window.runAgain(spec), {
        data: [{
            type: 'csv',
            outputTableName: 't',
            csvObject: [['id', 'v', 'Latitude', 'Longitude'], [7, 70, 40.751, -73.985], [8, 80, 40.752, -73.984], [9, 90, 40.753, -73.983]],
            geometryColumns: true,
        }],
        plot,
    } as UrbanSpec);
    expect(await values()).toEqual([70, 80, 90]);
});

test('destroy releases the maps and the registries of a run', async ({ page }) => {
    await runSpec(page, {
        data: [{ type: 'geojson', geojsonFileUrl: '/data/mnt_neighs.geojson', outputTableName: 'n' }],
        map: { layerRefs: [{ dataRef: 'n' }] },
    });
    const result = await page.evaluate(() => {
        const map = window.grammar.maps[0] as unknown as { _isDestroyed: boolean };
        const before = map._isDestroyed;
        window.grammar.destroy();
        return { before, after: map._isDestroyed, maps: window.grammar.maps.length, layer: window.grammar.mapLayer('n') ?? null };
    });
    expect(result).toEqual({ before: false, after: true, maps: 0, layer: null });
});

test('destroys a map whose layers fail to load, so none of its controls stay on the page', async ({ page }) => {
    // A map joined the grammar's list, which destroy() empties, only once its layers loaded. A map whose layers failed was
    // never destroyed: its menu, legend and watermark stayed on the page, with its event handlers and GPU buffers.
    await expect(runSpec(page, {
        data: [area, zones],
        map: { layerRefs: [{ dataRef: 'zones' }, { dataRef: 'nowhere' }] },
    })).rejects.toThrow('nowhere');
    expect(await page.evaluate(() => ({
        maps: window.grammar.maps.length,
        controls: document.querySelectorAll('#stage .autk-map-branding, #stage #autkMapUi, #stage #autkMapSubMenu, #stage #autkMapLegend').length,
    }))).toEqual({ maps: 0, controls: 0 });

    // The same map with its layers loaded leaves its controls in place.
    await runSpec(page, { data: [area, zones], map: { layerRefs: [{ dataRef: 'zones' }] } });
    expect(await page.evaluate(() => document.querySelectorAll('#stage .autk-map-branding, #stage #autkMapUi').length)).toBe(2);
});

test('keeps two areas in two workspaces, each with its own extent and its own map', async ({ page }) => {
    // The same table name in each workspace: without workspaces the second area's tables would replace the first one's.
    const area = (workspace: string, bbox: number[]) => ({
        type: 'osm', outputTableName: 'osm', workspace, pbfFileUrl: '/data/lower_mnt.osm.pbf',
        queryArea: { bbox }, autoLoadLayers: { layers: ['roads'] },
    }) as DataSourceSpec;
    const west = [-74.0155, 40.703, -74.0105, 40.7075];
    const east = [-74.0020, 40.7125, -73.9975, 40.7170];
    await runSpec(page, {
        data: [area('west', west), area('east', east)],
        map: [
            { workspace: 'west', layerRefs: [{ dataRef: 'osm_roads', title: 'west roads' }] },
            { workspace: 'east', layerRefs: [{ dataRef: 'osm_roads', title: 'east roads' }] },
        ],
    });
    expect((await mapLayers(page, 'map0')).map((layer) => layer.id)).toEqual(['west roads']);
    expect((await mapLayers(page, 'map1')).map((layer) => layer.id)).toEqual(['east roads']);
    // Thin roads on a flat background give few colors, so count the pixels that differ from the background instead.
    const images: string[] = [];
    for (const canvasId of ['map0', 'map1']) {
        const url = await page.evaluate((id) => window.readMap(id), canvasId);
        images.push(url);
        const png = PNG.sync.read(Buffer.from(url.split(',')[1], 'base64'));
        let painted = 0;
        for (let i = 4; i < png.data.length; i += 4) {
            if (png.data[i] !== png.data[0] || png.data[i + 1] !== png.data[1] || png.data[i + 2] !== png.data[2]) painted++;
        }
        expect(painted, `#${canvasId} draws its roads`).toBeGreaterThan(200);
    }
    // Two different areas, two different pictures.
    expect(images[0]).not.toEqual(images[1]);

    // `data` lists the default workspace's tables, which are none here.
    expect(await page.evaluate(() => Object.keys(window.grammar.data))).toEqual([]);
});

/** A point given in degrees, in Web Mercator (EPSG:3857) meters, on its sphere. */
function webMercator(lon: number, lat: number): [number, number] {
    const a = 6378137;
    return [(a * lon * Math.PI) / 180, a * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
}

test('stores the tables of each workspace in the CRS and on the grid its workspaces entry sets', async ({ page }) => {
    // The default workspace in Web Mercator on a 10 m grid, "web" in Web Mercator on autk-db's 1 cm grid, and "plain",
    // which has no entry, as autk-db keeps a workspace: in World Mercator.
    const into = (workspace: string, source: DataSourceSpec) => ({ ...source, workspace }) as DataSourceSpec;
    await runSpec(page, {
        workspaces: [
            { coordinateFormat: 'EPSG:3857', precisionGrid: 10 },
            { name: 'web', coordinateFormat: 'EPSG:3857', precisionGrid: 0.01 },
        ],
        data: [area, zones, into('web', area), into('plain', area)],
        map: [
            { layerRefs: [{ dataRef: 'zones' }] },
            { workspace: 'web', layerRefs: [{ dataRef: 'area' }] },
            { workspace: 'plain', layerRefs: [{ dataRef: 'area' }] },
        ],
    });

    // The default workspace's zones, in Web Mercator meters, each coordinate on the 10 m grid (autk-db's default grid,
    // 1 cm, would leave them up to 5 m off it).
    const extents = await page.evaluate(() => window.featureExtents('zones'));
    expect(extents).toHaveLength(4);
    expect(extents.flat().filter((value) => Math.abs(value - 10 * Math.round(value / 10)) > 1e-6), 'coordinates off the 10 m grid').toEqual([]);
    const side = (i: number, pick: (...values: number[]) => number) => pick(...extents.map((extent) => extent[i]));
    const [west, south] = webMercator(-73.99, 40.75);
    const [east, north] = webMercator(-73.975, 40.753);
    [[side(0, Math.min), west], [side(1, Math.min), south], [side(2, Math.max), east], [side(3, Math.max), north]]
        .forEach(([actual, expected], i) => expect(Math.abs(actual - expected), `zones extent ${i}, in meters`).toBeLessThan(6));

    // A map's origin is the middle of its first layer's extent: area's, in Web Mercator in "web" and in World Mercator,
    // autk-db's default, in "plain". The two lie about 33 km apart at this latitude.
    const middle = (project: (lon: number, lat: number) => [number, number]) => {
        const [x0, y0] = project(-74.0, 40.735);
        const [x1, y1] = project(-73.96, 40.775);
        return [(x0 + x1) / 2, (y0 + y1) / 2];
    };
    const origins = await page.evaluate(() => window.grammar.maps.map((map) => [...map.layerManager.origin]));
    expect(origins).toHaveLength(3);
    const expected: Array<[string, number[], number[]]> = [['web', origins[1], middle(webMercator)], ['plain', origins[2], middle(worldMercator)]];
    for (const [name, origin, [x, y]] of expected) {
        expect(Math.abs(origin[0] - x), `${name} origin x`).toBeLessThan(2);
        expect(Math.abs(origin[1] - y), `${name} origin y`).toBeLessThan(2);
    }
});

// The gallery examples of the keys 5.0.0 adds, each run as the gallery runs it, and checked for what it draws or computes.

/** A gallery example's spec, loaded in the page (see window.exampleSpec), to run it changed. */
function exampleSpec(page: Page, name: string): Promise<UrbanSpec> {
    return page.evaluate((example) => window.exampleSpec(example), name);
}

/** A spec whose OSM sources read the gallery's lower Manhattan extract instead of the Overpass API. */
function withExtract(spec: UrbanSpec): UrbanSpec {
    return { ...spec, data: spec.data?.map((source) => (source.type === 'osm' ? { ...source, pbfFileUrl: '/data/lower_mnt.osm.pbf' } : source)) };
}

test('colors the buildings of property-func-map by the height_sq its compute pass writes', async ({ page }) => {
    // The pass writes compute.height_sq. The example named height_sq, which no feature has, so autk-map drew the
    // buildings in one color.
    await runSpec(page, withExtract(await exampleSpec(page, 'property-func-map')));
    const squares = await page.evaluate(async () =>
        (await window.grammar.data.table_osm_buildings).features.map((feature) => feature.properties?.compute?.height_sq));
    expect(squares.length).toBeGreaterThan(0);
    expect(squares.filter((square) => !Number.isFinite(square))).toEqual([]);
    const layer = (await layerById(page)).table_osm_buildings;
    expect(layer).toMatchObject({ isColorMap: true, interpolator: 'interpolateRdBu' });
    // Its scale runs over the squares, which pass 2500 (a building 50 m tall).
    const domain = (layer.domain ?? []).map(Number);
    expect(domain.length).toBeGreaterThan(1);
    expect(domain.every(Number.isFinite)).toBe(true);
    expect(Math.max(...domain)).toBeGreaterThan(2500);
    expect(Math.max(...domain)).toBeLessThanOrEqual(Math.max(...squares));
});

test('draws the second area of osm-layers-api-multi whole, as it draws alone, though both share one workspace', async ({ page }) => {
    // The first source sets the workspace's extent, which later CSV, JSON, GeoJSON and GeoTIFF sources are cut to. An OSM
    // source builds its layers inside its own area, so the Financial District, loaded second, keeps all of its own.
    const spec = withExtract(await exampleSpec(page, 'osm-layers-api-multi'));
    const tables = ['surface', 'parks', 'water', 'roads', 'buildings'].map((layer) => `table_osm_${layer}`);
    const summaries = () => page.evaluate(async (names) => {
        // A table's feature count, and its extent when it has features.
        const summary: Record<string, { features: number; extent: number[] }> = {};
        for (const name of names) {
            const boxes = await window.featureExtents(name);
            const side = (i: number, pick: (...values: number[]) => number) => pick(...boxes.map((box) => box[i]));
            summary[name] = { features: boxes.length, extent: boxes.length ? [side(0, Math.min), side(1, Math.min), side(2, Math.max), side(3, Math.max)] : [] };
        }
        return summary;
    }, tables);

    await runSpec(page, spec);
    const together = await summaries();
    await expectDrawn(page, 'map0');
    await expectDrawn(page, 'map1');

    await runSpec(page, { data: [spec.data![1]], map: (spec.map as MapSpec[])[1] });
    const alone = await summaries();
    for (const name of ['table_osm_surface', 'table_osm_roads', 'table_osm_buildings'])
        expect(alone[name].features, `${name} features`).toBeGreaterThan(0);
    for (const name of tables) {
        expect(together[name].features, `${name} features`).toBe(alone[name].features);
        together[name].extent.forEach((value, i) =>
            expect(Math.abs(value - alone[name].extent[i]), `${name} extent ${i}, in meters`).toBeLessThan(1));
    }
});

test('tilts the view of map-camera to its zoom, pitch and bearing around the point the map fits', async ({ page }) => {
    const spec = await exampleSpec(page, 'map-camera');
    const { camera, ...untilted } = spec.map as MapSpec;
    // The same map without a camera: the view that fits its layers, looking straight down.
    await runSpec(page, { ...spec, map: untilted });
    const fitted = await page.evaluate(() => window.cameraState('map0'));

    await run(page, 'map-camera');
    const view = await page.evaluate(() => window.cameraState('map0'));
    const { zoom, pitch, bearing } = camera as Required<CameraSpec>;
    const distance = 10000 / 2 ** (zoom - 10);
    const [tilt, heading] = [pitch, bearing].map((degrees) => (degrees * Math.PI) / 180);
    // The map still looks at the point it fits, from `distance` away, tilted `pitch` from the vertical and facing `bearing`
    // clockwise from north, so the eye is south-west of that point.
    expect(view.lookAt[0]).toBeCloseTo(fitted.lookAt[0], 3);
    expect(view.lookAt[1]).toBeCloseTo(fitted.lookAt[1], 3);
    expect(view.eye[0] - view.lookAt[0]).toBeCloseTo(-distance * Math.sin(tilt) * Math.sin(heading), 3);
    expect(view.eye[1] - view.lookAt[1]).toBeCloseTo(-distance * Math.sin(tilt) * Math.cos(heading), 3);
    expect(view.eye[2] - view.lookAt[2]).toBeCloseTo(distance * Math.cos(tilt), 3);
    await expectDrawn(page, 'map0');
});

test('links the plot of linked-views to its map by their ids: a click in the plot highlights the layer, a pick selects in the plot', async ({ page }) => {
    const { tables, plotSvgs } = await run(page, 'linked-views');
    expect(plotSvgs).toBeGreaterThan(0);
    await expectDrawn(page, 'map0');
    const layer = async () => (await layerById(page))['Neighborhood area'];
    // The link makes the layer it names pickable, and nothing is highlighted yet.
    expect(await layer()).toMatchObject({ isPick: true, highlightedIds: [] });

    // A click on a mark of the plot highlights its feature on that layer.
    const clicked = await page.evaluate(() => {
        const mark = document.querySelector('#plot .autkMark') as Element & { __data__?: { autkIds?: number[] } };
        mark.dispatchEvent(new MouseEvent('click'));
        return mark.__data__?.autkIds;
    });
    expect(clicked).toEqual([expect.any(Number)]);
    expect((await layer()).highlightedIds).toEqual(clicked);

    // A pick on the layer selects the feature in the plot, which the grammar knows by its id.
    const picked = (clicked![0] + 1) % tables.neighborhoods.features;
    await page.evaluate((id) => window.grammar.maps[0].events.emit('picking' as never, { selection: [id], layerId: 'Neighborhood area' } as never), picked);
    expect(await page.evaluate(() => [...(window.grammar as any)._plotRegistry.get('shapePlot').selection])).toEqual([picked]);
});

test('places the views of linked-views in the panes the hub builds: side by side, its gap apart, drawn and linked', async ({ page }) => {
    // The hub arranges a spec with a layout by arrangeViews, as autarkjs.org's playground and Curio do.
    const spec = await exampleSpec(page, 'linked-views');
    expect(spec.layout).toEqual({ type: 'horizontal', gap: 12 });
    const { targets, panes } = await page.evaluate((s) => window.runInPanes(s, 1212, 500), spec);
    expect(targets).toEqual({ map: 'map-0', plot: 'plot-0' });
    expect(panes.map(({ target, viewId }) => [target, viewId])).toEqual([['map-0', 'neighborhoodMap'], ['plot-0', 'shapePlot']]);
    // One row of two panes, each half of the stage less the gap: the map on the left, 12 px, then the plot.
    const [map, plot] = panes;
    for (const pane of panes) {
        expect(pane.width).toBeCloseTo(600, 0);
        expect(pane.height).toBeCloseTo(500, 0);
    }
    expect(plot.top).toBeCloseTo(map.top, 0);
    expect(plot.left - (map.left + map.width)).toBeCloseTo(12, 0);
    await expectDrawn(page, 'map-0');

    // The views draw and link in their panes: a click on a mark lights the neighborhood it stands for.
    const clicked = await page.evaluate(() => {
        const mark = document.querySelector('#plot-0 .autkMark') as Element & { __data__?: { ntaname?: string } };
        mark.dispatchEvent(new MouseEvent('click'));
        return mark.__data__?.ntaname;
    });
    expect(clicked).toEqual(expect.any(String));
    const drawn = await page.evaluate(() => window.drawnRows('map-0', 'Neighborhood area'));
    const lit = (await layerById(page, 'map-0'))['Neighborhood area'].highlightedIds ?? [];
    expect(lit.map((position) => drawn[position]?.ntaname)).toEqual([clicked]);
});

test('places views in a grid by its columns and gap, and stacks them without a layout, in the panes the hub builds', async ({ page }) => {
    const views: UrbanSpec = {
        data: [area, zones],
        map: [{ layerRefs: [{ dataRef: 'zones' }] }, { id: 'right', layerRefs: [{ dataRef: 'zones' }] }],
        plot: { id: 'sc', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'] },
    };
    const places = (panes: PaneBox[]) => panes.map((pane) => [
        pane.target, pane.viewId, Math.round(pane.left - panes[0].left), Math.round(pane.top - panes[0].top), Math.round(pane.width), Math.round(pane.height),
    ]);

    // Two columns by default: both maps on the first row, the plot under the first map, 400 by 300 px each, 10 px apart.
    const grid = await page.evaluate((s) => window.runInPanes(s, 810, 610), { ...views, layout: { type: 'grid', gap: 10 } } as UrbanSpec);
    expect(grid.targets).toEqual({ map: ['map-0', 'map-1'], plot: 'plot-0' });
    expect(places(grid.panes)).toEqual([['map-0', null, 0, 0, 400, 300], ['map-1', 'right', 410, 0, 400, 300], ['plot-0', 'sc', 0, 310, 400, 300]]);
    expect((await mapLayers(page, 'map-1')).map((layer) => layer.id)).toEqual(['zones']);

    // Without a layout the panes stack, with no gap.
    const stacked = await page.evaluate((s) => window.runInPanes(s, 400, 600), views);
    expect(places(stacked.panes)).toEqual([['map-0', null, 0, 0, 400, 200], ['map-1', 'right', 0, 200, 400, 200], ['plot-0', 'sc', 0, 400, 400, 200]]);
});

test("draws a plot's axis titles in the gallery hub, in the color of its text", async ({ page }) => {
    // autk-plot puts each axis title inside its axis group, which d3 gives fill="none", and leaves the title's fill to
    // the page: without a rule of the hub's own, the titles of plot-colors were drawn with no fill.
    const spec = await exampleSpec(page, 'plot-colors');
    await page.evaluate((s) => window.runInPanes(s, 1212, 500, 'hub'), spec);
    const titles = await page.evaluate(() => Array.from(document.querySelectorAll('#plot-0 .axis-label'), (title) => {
        const style = getComputedStyle(title);
        return { text: title.textContent, fill: style.fill, color: style.color };
    }));
    expect(titles.map((title) => title.text)).toEqual(['Neighborhood', 'Noise complaints']);
    for (const title of titles) {
        expect(title.fill, title.text ?? '').not.toBe('none');
        expect(title.fill, title.text ?? '').toBe(title.color);
    }
});

test('draws band 24 of geotiff-raster on its scheme, in at most maxRasterCells cells, each one a cell of the file', async ({ page }) => {
    const layerId = 'Summer surface temperature, 2024 (°C)';
    const spec = await exampleSpec(page, 'geotiff-raster');
    const [source, ...others] = spec.data!;
    const { maxRasterCells, resampleMethod, ...wholeFile } = source as GeoTiffDataSourceSpec;

    // The polygon of the raster's extent frames the map, which a raster does not.
    await run(page, 'geotiff-raster');
    const layers = await mapLayers(page);
    expect(layers.map((layer) => [layer.id, layer.type])).toEqual([['Raster extent', 'polygons'], [layerId, 'raster']]);
    const cells = await page.evaluate((id) => window.rasterCells('map0', id).values, layerId);
    // The file holds 22 x 15 cells, more than maxRasterCells, so autk-db reads fewer, and every one holds a temperature.
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(maxRasterCells!);
    expect(cells.filter((value) => !Number.isFinite(value))).toEqual([]);
    // Colored on YlOrRd from its lowest cell to its highest.
    const [min, max] = [Math.min(...cells), Math.max(...cells)];
    expect(layers[1]).toMatchObject({ isColorMap: true, interpolator: 'interpolateYlOrRd', domain: [min, max] });
    expect((await cellsOffScheme(page, 'interpolateYlOrRd', [min, max], 'map0', layerId)).off).toBe(0);
    await expectDrawn(page, 'map0');

    // The same band of the whole file: 330 cells, from 26.765 to 34.577 degrees Celsius as rasterio reads them. Nearest
    // resampling keeps measured values, so every cell the example draws is one of these.
    expect(resampleMethod).toBe('nearest');
    await runSpec(page, { ...spec, data: [wholeFile as DataSourceSpec, ...others] });
    const file = await page.evaluate((id) => window.rasterCells('map0', id).values, layerId);
    expect(file.length).toBe(22 * 15);
    expect(Math.min(...file)).toBeCloseTo(26.76499, 4);
    expect(Math.max(...file)).toBeCloseTo(34.57745, 4);
    const measured = new Set(file);
    expect(cells.filter((value) => !measured.has(value))).toEqual([]);
});

test('writes the pass of compute-output-table into a new table drawn as polygons, and leaves the buildings as they were', async ({ page }) => {
    const { tables } = await run(page, 'compute-output-table');
    expect(tables.building_heights.features).toBeGreaterThan(0);
    expect(tables.building_heights.features).toBe(tables.fidi_buildings.features);
    const { computed, sourceComputed } = await page.evaluate(async () => {
        const heights = await window.grammar.data.building_heights;
        const buildings = await window.grammar.data.fidi_buildings;
        return {
            computed: heights.features.map((feature) => ({ height: feature.properties?.height ?? null, feet: feature.properties?.compute?.feet })),
            sourceComputed: buildings.features.filter((feature) => feature.properties?.compute !== undefined).length,
        };
    });
    // The pass reads `height` as autk-compute reads an attribute, as a number and 0 where OpenStreetMap gives none, and
    // multiplies it in float32.
    const wrong = computed.filter(({ height, feet }) => {
        const meters = Number(height);
        const expected = (Number.isFinite(meters) ? meters : 0) * 3.28084;
        return !(Math.abs(feet - expected) <= 1e-4 * Math.max(1, expected));
    });
    expect(wrong).toEqual([]);
    expect(computed.filter(({ feet }) => feet > 0).length).toBeGreaterThan(0);
    expect(sourceComputed, 'buildings with a compute column').toBe(0);
    // The map draws the new table flat, as its layerType says, though it was computed from a buildings table.
    expect((await layerById(page))['Building height (ft)']).toMatchObject({ type: 'polygons', isColorMap: true, interpolator: 'interpolateViridis' });
    await expectDrawn(page, 'map0');
});

test('renders the sky each street of compute-render sees into a new table, every pixel of its frames in one class', async ({ page }) => {
    const pass = (await exampleSpec(page, 'compute-render')).compute![0] as RenderComputeSpec;
    const directions = pass.viewpoints.sampling!.directions!;
    const { tables } = await run(page, 'compute-render');
    expect(tables.street_sky.features).toBeGreaterThan(0);
    expect(tables.street_sky.features).toBe(tables.wall_st_roads.features);
    const { renders, sourceRendered } = await page.evaluate(async () => ({
        renders: (await window.grammar.data.street_sky).features.map((feature) => feature.properties?.compute?.render),
        sourceRendered: (await window.grammar.data.wall_st_roads).features.filter((feature) => feature.properties?.compute?.render !== undefined).length,
    }));
    // Each street is seen from its middle once in every direction, and each pixel of a frame is a building or, as
    // includeBackground and backgroundLayerType say, the sky: the two shares of a street add up to 1.
    const wrong = renders.filter((render) => {
        const classes = Object.entries(render?.classes ?? {}) as Array<[string, number]>;
        const total = classes.reduce((sum, [, share]) => sum + share, 0);
        return render?.sampleCount !== directions
            || classes.map(([name]) => name).join() !== 'buildings,sky'
            || classes.some(([, share]) => !(share >= 0 && share <= 1))
            || Math.abs(total - 1) > 1e-6;
    });
    expect(wrong).toEqual([]);
    // Streets see buildings, some more sky than others.
    expect(renders.some((render) => render.classes.buildings > 0)).toBe(true);
    const sky = renders.map((render) => render.classes.sky as number);
    expect(Math.max(...sky)).toBeGreaterThan(Math.min(...sky));
    expect(sourceRendered, 'streets with a render result').toBe(0);
    // The new table is drawn as its viewpoints' table is, as roads, colored by its share of sky.
    expect((await layerById(page))['Share of sky seen from the street']).toMatchObject({ type: 'roads', isColorMap: true, interpolator: 'interpolateBlues' });
    await expectDrawn(page, 'map0');
});

test('keeps the two areas of workspaces apart, each map drawing its whole area', async ({ page }) => {
    await run(page, 'workspaces');
    expect((await mapLayers(page, 'map0')).map((layer) => layer.id)).toEqual(['Manhattan']);
    expect((await mapLayers(page, 'map1')).map((layer) => layer.id)).toEqual(['New York City by borough']);
    // A map's origin is the middle of its first layer's extent, in World Mercator meters. In one workspace, the city's
    // neighborhoods would be cut to Manhattan, the area loaded first, and both origins would lie in Manhattan.
    const middle = ([west, south, east, north]: number[]) => {
        const [x0, y0] = worldMercator(west, south);
        const [x1, y1] = worldMercator(east, north);
        return [(x0 + x1) / 2, (y0 + y1) / 2];
    };
    // The extents of mnt_neighs.geojson and nyc_neigs.csv, [west, south, east, north] in degrees.
    const expected = [
        middle([-74.04773, 40.682917, -73.910426, 40.878964]),
        middle([-74.255591, 40.496134, -73.700009, 40.915533]),
    ];
    const origins = await page.evaluate(() => window.grammar.maps.map((map) => [...map.layerManager.origin]));
    expect(origins).toHaveLength(2);
    origins.forEach((origin, i) => {
        expect(Math.abs(origin[0] - expected[i][0]), `map${i} origin x`).toBeLessThan(2);
        expect(Math.abs(origin[1] - expected[i][1]), `map${i} origin y`).toBeLessThan(2);
    });
    await expectDrawn(page, 'map0');
    await expectDrawn(page, 'map1');
    // `data` lists the default workspace's tables, which are none here.
    expect(await page.evaluate(() => Object.keys(window.grammar.data))).toEqual([]);
});

/** The latitude, in degrees, of a World Mercator (EPSG:3395) planar y: the inverse of worldMercator, by bisection. */
function worldMercatorLatitude(y: number): number {
    let [south, north] = [-85, 85];
    for (let i = 0; i < 60; i++) {
        const middle = (south + north) / 2;
        if (worldMercator(0, middle)[1] < y) south = middle;
        else north = middle;
    }
    return (south + north) / 2;
}

test('draws the points of points-true-size with a radius of pointSize meters on the ground', async ({ page }) => {
    const layerRef = ((await exampleSpec(page, 'points-true-size')).map as MapSpec).layerRefs.find((layer) => layer.dataRef === 'noise')!;
    const { tables } = await run(page, 'points-true-size');
    expect(tables.noise.features).toBeGreaterThan(0);
    // autk-map's radius is in planar units: the meters times World Mercator's scale at the middle of the points' extent,
    // about 1.32 here.
    const ys = (await page.evaluate(() => window.featureExtents('noise'))).flatMap(([, south, , north]) => [south, north]);
    const latitude = worldMercatorLatitude((Math.min(...ys) + Math.max(...ys)) / 2);
    const layer = (await layerById(page))[layerRef.title!];
    expect(layer.type).toBe('points');
    expect(layer.pointSize).toBeCloseTo(layerRef.pointSize! * worldMercatorScale(latitude), 3);
    expect(layer.pointSize, "a radius well below autk-map's default of 64 planar units").toBeLessThan(64);
    expect(await pixelsIn(page, layerRef.color!, 'noise discs')).toBeGreaterThan(0);
});

test('counts the parks near each cell of heatmap-centroids from their edges, as its useCentroid says', async ({ page }) => {
    const layerId = 'Parks within about 150 m';
    const spec = await exampleSpec(page, 'heatmap-centroids');
    const [osm, source] = spec.data!;
    const heatmap = source as HeatmapSourceSpec;
    expect(heatmap.near.useCentroid).toBe(false);
    await run(page, 'heatmap-centroids');
    const fromEdges = (await heatmapLayer(page, 'map0', layerId)).finite;
    await expectDrawn(page, 'map0');

    // The same heatmap measured from each park's centroid, autk-db's default. A cell by a park's edge can lie far from its
    // centroid, so the edges reach more parks. (Point rows have no extent: for them the two agree.)
    await runSpec(page, { ...spec, data: [osm, { ...heatmap, near: { ...heatmap.near, useCentroid: true } }] });
    const fromCentroids = (await heatmapLayer(page, 'map0', layerId)).finite;
    expect(fromEdges).toHaveLength(heatmap.grid.rows * heatmap.grid.columns);
    expect(fromCentroids).toHaveLength(fromEdges.length);
    const sum = (counts: number[]) => counts.reduce((total, count) => total + count, 0);
    expect(sum(fromEdges)).toBeGreaterThan(sum(fromCentroids));
    expect(fromEdges).not.toEqual(fromCentroids);
});

test('maps the ten neighborhoods of sql-source with the most noise complaints, which its query selects', async ({ page }) => {
    const { tables } = await run(page, 'sql-source');
    expect(tables.noisiest.features).toBe(10);
    const { all, top } = await page.evaluate(async () => ({
        all: (await window.grammar.data.neighborhoods).features.map((feature) => Number(feature.properties?.sjoin?.count?.noise ?? 0)),
        top: (await window.grammar.data.noisiest).features.map((feature) => Number(feature.properties?.complaints)),
    }));
    // The query's ten rows hold the ten greatest counts the join wrote, each under the name its SELECT gives it.
    const descending = (counts: number[]) => [...counts].sort((a, b) => b - a);
    expect(descending(top)).toEqual(descending(all).slice(0, 10));
    expect(top.every((count) => count > 0)).toBe(true);
    // The map colors them by that count, over the neighborhoods drawn in gray.
    expect((await layerById(page))['Noise complaints, the ten noisiest']).toMatchObject({ type: 'polygons', isColorMap: true, interpolator: 'interpolateReds' });
    await expectDrawn(page, 'map0');
});

// Plot keys: `zones` (above) holds four values, 0 to 30, and `trees` a kind of tree in each of four rows, oak, elm, ash
// and oak again, so its kinds are categories in that order.
const trees: DataSourceSpec = {
    type: 'csv',
    outputTableName: 'trees',
    csvObject: [['id', 'kind', 'n'], ['a', 'oak', 4], ['b', 'elm', 2], ['c', 'ash', 3], ['d', 'oak', 1]],
};

/** A plot spec with the fields given, typed as the grammar's (a scheme is written by its name). */
const plotOf = (fields: Record<string, unknown>) => fields as unknown as PlotSpec;

/** The marks the plots in #target draw, with the row each stands for and its colors (see window.plotMarks). */
function plotMarks(page: Page, target = 'plot'): Promise<DrawnMark[]> {
    return page.evaluate((id) => window.plotMarks(id), target);
}

/** autk-core's color for a value on a scheme over a domain, as autk-plot paints a mark: `rgb(r, g, b)`. */
async function schemeFill(page: Page, value: number, interpolator: string, domain: number[]): Promise<string> {
    const { r, g, b } = await page.evaluate(([v, i, d]) => window.schemeColor(v, i, d), [value, interpolator, domain] as [number, string, number[]]);
    return `rgb(${r}, ${g}, ${b})`;
}

test("colors a plot's marks by the scheme of numbers and the scheme of categories it names, and refuses one of the other kind", async ({ page }) => {
    // Numbers: each bar in the color of its value on viridis, rather than autk-plot's reds, from the lowest value, 0, to
    // the highest, 30.
    await runSpec(page, {
        data: [area, zones],
        plot: plotOf({ id: 'z', dataRef: 'zones', mark: 'bar', axis: ['id', 'v'], color: 'v', colorMapInterpolator: 'interpolateViridis' }),
    });
    const bars = await plotMarks(page);
    expect(bars).toHaveLength(4);
    for (const { datum, fill } of bars)
        expect(fill, `bar ${datum?.id}`).toBe(await schemeFill(page, Number(datum?.v), 'interpolateViridis', [0, 30]));

    // Categories: oak, elm and ash, in the order they first appear, take Set1's first three colors, rather than
    // autk-plot's Observable10.
    await runSpec(page, {
        data: [trees],
        plot: plotOf({ id: 't', dataRef: 'trees', mark: 'bar', axis: ['id', 'n'], color: 'kind', categoricalColorMapInterpolator: 'schemeSet1' }),
    });
    const set1: Record<string, string> = { oak: 'rgb(228, 26, 28)', elm: 'rgb(55, 126, 184)', ash: 'rgb(77, 175, 74)' };
    const kinds = await plotMarks(page);
    expect(kinds.map(({ datum }) => datum?.kind).sort()).toEqual(['ash', 'elm', 'oak', 'oak']);
    for (const { datum, fill } of kinds) expect(fill, `bar ${datum?.id}`).toBe(set1[String(datum?.kind)]);

    // A scheme of the other kind is refused before anything is drawn.
    await expect(runSpec(page, {
        data: [trees],
        plot: plotOf({ id: 't', dataRef: 'trees', mark: 'bar', axis: ['id', 'n'], color: 'kind', colorMapInterpolator: 'schemeSet1' }),
    })).rejects.toThrow('Plot "t": colorMapInterpolator "schemeSet1" is a categorical scheme');
});

test("colors a scatter plot's points by their color column from its first draw", async ({ page }) => {
    // autk-plot's scatter plot drew every point in its mark color, and colored the points by value only once a
    // selection restyled them.
    await runSpec(page, { data: [area, zones], plot: plotOf({ id: 's', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'], color: 'v' }) });
    const points = await plotMarks(page);
    expect(points).toHaveLength(4);
    for (const { datum, fill } of points)
        expect(fill, `point ${datum?.id}`).toBe(await schemeFill(page, Number(datum?.v), 'interpolateReds', [0, 30]));
});

/** autk-plot's mark color: the fill of a mark that is neither colored by value nor selected. */
const markGray = 'rgb(191, 191, 191)';

test("colors a plot over its colorMapRange, colorMapDomain's categories or normalization's percentiles", async ({ page }) => {
    const bar = (fields: Record<string, unknown>) => plotOf({ id: 'z', dataRef: 'zones', mark: 'bar', axis: ['id', 'v'], color: 'v', ...fields });

    // One range on two plots: zones (0 to 30) and lots (0 to 60) color each value over [0, 60], so 20 has one color in
    // both, where each plot's own values would put it two thirds up the zones' scale and a third up the lots'.
    await runSpec(page, {
        data: [area, zones, lots],
        plot: [bar({ colorMapRange: [0, 60] }), bar({ id: 'l', dataRef: 'lots', colorMapRange: [0, 60] })],
    }, 'each');
    const ranged = [...(await plotMarks(page, 'plot0')), ...(await plotMarks(page, 'plot1'))].map(({ datum, fill }) => ({ v: Number(datum?.v), fill }));
    expect(ranged).toHaveLength(8);
    for (const { v, fill } of ranged) expect(fill, `bar of ${v}`).toBe(await schemeFill(page, v, 'interpolateReds', [0, 60]));
    expect(new Set(ranged.filter(({ v }) => v === 20).map(({ fill }) => fill)).size).toBe(1);

    // The 25th and 75th percentiles of the zones' values, 7.5 and 22.5, end the scale.
    await runSpec(page, { data: [area, zones], plot: bar({ normalization: { mode: 'percentile', lowerPercentile: 25, upperPercentile: 75 } }) });
    for (const { datum, fill } of await plotMarks(page))
        expect(fill, `bar ${datum?.id}`).toBe(await schemeFill(page, Number(datum?.v), 'interpolateReds', [7.5, 22.5]));

    // colorMapDomain reads the values as categories, in its order: 10 takes Observable10's first color and 20 its
    // second, and 0 and 30, which it does not name, take the mark color.
    await runSpec(page, { data: [area, zones], plot: bar({ colorMapDomain: ['10', '20'] }) });
    const byValue = Object.fromEntries((await plotMarks(page)).map(({ datum, fill }) => [String(datum?.v), fill]));
    expect(byValue).toEqual({
        '0': markGray,
        '10': await schemeFill(page, 0, 'schemeObservable10', [10, 20]),
        '20': await schemeFill(page, 1, 'schemeObservable10', [10, 20]),
        '30': markGray,
    });

    // A plot colored by categories ignores the range, as a layer with a categorical scheme does: each kind keeps its
    // color, where autk-core would read the range as two categories, 0 and 60, and draw every bar in the mark color.
    await runSpec(page, {
        data: [trees],
        plot: plotOf({ id: 't', dataRef: 'trees', mark: 'bar', axis: ['id', 'n'], color: 'kind', colorMapRange: [0, 60] }),
    });
    const kinds = ['oak', 'elm', 'ash'];
    for (const { datum, fill } of await plotMarks(page))
        expect(fill, `bar ${datum?.id}`).toBe(await schemeFill(page, kinds.indexOf(String(datum?.kind)) / 2, 'schemeObservable10', [0, 1, 2]));

    // A low above its high is refused when the spec runs, as on a layer, since JSON Schema cannot compare two values.
    await expect(runSpec(page, { data: [area, zones], plot: bar({ colorMapRange: [30, 0] }) }))
        .rejects.toThrow('Plot "z": colorMapRange low (30) must be less than high (0).');
});

test("formats the tick labels of a plot's axes with its tickFormats", async ({ page }) => {
    const ticks = (selector: string) => page.evaluate(([target, axes]) => window.plotTicks(target, axes), ['plot', selector] as [string, string]);
    const percent = (value: unknown) => `${(Number(value) * 100).toFixed(0)}%`;
    const zonesBy = (mark: string, tickFormats: unknown) =>
        runSpec(page, { data: [area, zones], plot: plotOf({ id: 'p', dataRef: 'zones', mark, axis: ['id', 'v'], tickFormats }) });

    // A scatter plot: the first formats the x axis, the zones' ids from 0 to 3, and the second the y axis, their values
    // from 0 to 30. autk-plot's '~s' would show 0.5 as "500m".
    await zonesBy('scatter', ['.2f', '.0%']);
    const [[x], [y]] = [await ticks('#axisX'), await ticks('#axisY')];
    expect(x.length).toBeGreaterThan(2);
    expect(y.length).toBeGreaterThan(2);
    for (const [value, text] of x) expect(text).toBe(Number(value).toFixed(2));
    for (const [value, text] of y) expect(text).toBe(percent(value));

    // A bar chart: the first formats the x labels that read as numbers, the ids, and the second the y axis.
    await zonesBy('bar', ['.1f', '.0%']);
    expect((await ticks('#axisX'))[0].map(([, text]) => text)).toEqual(['0.0', '1.0', '2.0', '3.0']);
    for (const [value, text] of (await ticks('#axisY'))[0]) expect(text).toBe(percent(value));

    // Parallel coordinates: the first formats every axis of numbers, and the second none.
    await zonesBy('parallel-coordinates', ['.1f', '.0%']);
    const axes = await ticks('.autkBrush');
    expect(axes).toHaveLength(2);
    for (const axis of axes) {
        expect(axis.length).toBeGreaterThan(2);
        for (const [value, text] of axis) expect(text).toBe(Number(value).toFixed(1));
    }

    // A list d3-format cannot read is refused before anything is drawn.
    await expect(zonesBy('scatter', ['.2f'])).rejects.toThrow('Plot "p": tickFormats must hold two d3-format specifiers, [x, y].');
});

test("titles a plot's axes with its axisLabels, and the output of a transform value", async ({ page }) => {
    const titles = () => page.evaluate(() => window.plotAxisTitles());
    const zonesBy = (fields: Record<string, unknown>) =>
        runSpec(page, { data: [area, zones], plot: plotOf({ id: 'p', dataRef: 'zones', axis: ['id', 'v'], ...fields }) });

    // A scatter plot's x and y titles, and the axis titles of parallel coordinates, in the order of axis.
    await zonesBy({ mark: 'scatter', axisLabels: ['Zone', 'Value'] });
    expect(await titles()).toEqual(['Zone', 'Value']);
    await zonesBy({ mark: 'parallel-coordinates', axisLabels: ['Zone', 'Value'] });
    expect(await titles()).toEqual(['Zone', 'Value']);

    // A table's headers: a column without a title keeps its name, and each row has a cell under each header.
    await runSpec(page, {
        data: [trees],
        plot: plotOf({ id: 't', dataRef: 'trees', mark: 'table', axis: ['id', 'kind', 'n'], axisLabels: ['Tree', 'Kind'] }),
    });
    const table = await page.evaluate(() => ({
        headers: Array.from(document.querySelectorAll('#plot th'), (header) => header.textContent),
        cells: Array.from(document.querySelectorAll('#plot tr.autkMark'), (row) => row.querySelectorAll('td').length),
    }));
    expect(table).toEqual({ headers: ['Tree', 'Kind', 'n'], cells: [3, 3, 3, 3] });

    // A binned bar chart's count axis is titled value, autk-plot's own title for a transform's output, not "@transform".
    const binned = { mark: 'bar', axis: ['v', '@transform'], transform: { preset: 'binning-1d', options: { bins: 2 } } };
    await zonesBy(binned);
    expect(await titles()).toEqual(['v', 'value']);
    await zonesBy({ ...binned, axisLabels: ['Value', 'Zones'] });
    expect(await titles()).toEqual(['Value', 'Zones']);

    // More titles than columns are refused before anything is drawn.
    await expect(zonesBy({ mark: 'scatter', axisLabels: ['Zone', 'Value', 'Extra'] }))
        .rejects.toThrow('Plot "p": axisLabels has 3 titles for the 2 columns of axis.');
});

/** autk-plot's highlight color: the fill of a selected mark. */
const highlightBlue = 'rgb(93, 173, 226)';

test('selects the rows a plot names in selection as it is drawn, and highlights them on the layers it is linked to', async ({ page }) => {
    const plotSelection = () => page.evaluate(() => [...(window.grammar as any)._plotRegistry.get('p').selection]);
    /** The ids of the zones a layer of map0 highlights, read from the rows it draws at its highlighted positions. */
    const litZones = async (layerId: string) => {
        const drawn = await page.evaluate((id) => window.drawnRows('map0', id), layerId);
        const lit = (await layerById(page))[layerId]?.highlightedIds ?? [];
        return lit.map((position) => drawn[position]?.id).sort();
    };

    // A scatter plot of the zones, linked by mapRef: rows 1 and 3 are selected as it is drawn, in the highlight color,
    // and the layer highlights the same zones.
    await runSpec(page, {
        data: [area, zones],
        map: { layerRefs: [{ dataRef: 'zones', title: 'Zones' }] },
        plot: plotOf({ id: 'p', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'], events: ['click'], mapRef: 'zones', selection: [1, 3] }),
    });
    expect(await plotSelection()).toEqual([1, 3]);
    for (const { datum, fill } of await plotMarks(page))
        expect(fill, `point ${datum?.id}`).toBe([1, 3].includes(Number(datum?.id)) ? highlightBlue : markGray);
    expect(await litZones('Zones')).toEqual([1, 3]);

    // A bar chart without events, linked by links: its selected bar is lit, and so is the layer the link names.
    await runSpec(page, {
        data: [area, zones],
        map: { id: 'm', layerRefs: [{ dataRef: 'zones', title: 'Zones' }] },
        plot: plotOf({ id: 'p', dataRef: 'zones', mark: 'bar', axis: ['id', 'v'], selection: [2] }),
        links: [{ source: 'p', target: 'm', layer: 'Zones' }],
    });
    expect((await plotMarks(page)).map(({ datum, fill }) => [datum?.id, fill]).sort())
        .toEqual([[0, markGray], [1, markGray], [2, highlightBlue], [3, markGray]]);
    expect(await litZones('Zones')).toEqual([2]);

    // A binned bar chart lights the bin that holds a selected row.
    await runSpec(page, {
        data: [area, zones],
        plot: plotOf({ id: 'p', dataRef: 'zones', mark: 'bar', axis: ['v', '@transform'], transform: { preset: 'binning-1d', options: { bins: 2 } }, selection: [3] }),
    });
    const bins = await plotMarks(page);
    expect(bins.filter(({ fill }) => fill === highlightBlue).map(({ datum }) => datum?.autkIds)).toEqual([expect.arrayContaining([3])]);
    expect(bins.filter(({ fill }) => fill !== highlightBlue).every(({ datum }) => !(datum?.autkIds as number[]).includes(3))).toBe(true);

    // A row past the last is refused before the plot is drawn.
    await expect(runSpec(page, { data: [area, zones], plot: plotOf({ id: 'p', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'], selection: [4] }) }))
        .rejects.toThrow('Plot "p": selection names row 4, but the plot draws 4 rows.');
});

test('draws the features pickedComps names as picked on the layer that picks, and selects them in the plots linked to it', async ({ page }) => {
    // The zones in one gray, so the picked ones show in autk-map's highlight color, #5dade2.
    const zonesWith = (options: Partial<MapLayerSpec>, rest: Partial<UrbanSpec> = {}): UrbanSpec => ({
        data: [area, zones, blocks],
        map: { id: 'm', layerRefs: [{ dataRef: 'zones', title: 'Zones', color: '#d9d9d9', isPick: true, ...options }, { dataRef: 'blocks' }] },
        ...rest,
    });
    const litZones = async () => {
        const drawn = await page.evaluate(() => window.drawnRows('map0', 'Zones'));
        return ((await layerById(page)).Zones.highlightedIds ?? []).map((position) => drawn[position]?.id).sort();
    };

    // Without pickedComps nothing is picked.
    await runSpec(page, zonesWith({}));
    expect((await layerById(page)).Zones).toMatchObject({ isPick: true, highlightedIds: [] });
    expect(await pixelsIn(page, '#5dade2', 'no zone picked')).toBe(0);

    // Two zones, by their positions among those the layer draws: the layer picks them as it is drawn.
    await runSpec(page, zonesWith({ pickedComps: [1, 3] }));
    expect((await layerById(page)).Zones).toMatchObject({ isPick: true, highlightedIds: [1, 3] });
    expect(await pixelsIn(page, '#5dade2', 'two zones picked')).toBeGreaterThan(400);

    // A plot linked to the layer selects the same zones, though it draws its rows in their own order.
    await runSpec(page, zonesWith({ pickedComps: [2] }, {
        plot: plotOf({ id: 'p', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'] }),
        links: [{ source: 'p', target: 'm', layer: 'Zones' }],
    }));
    const [zone] = await litZones();
    expect((await plotMarks(page)).filter(({ fill }) => fill === highlightBlue).map(({ datum }) => datum?.id)).toEqual([zone]);

    // Refused: a layer that does not pick, positions that are not features the layer draws, a raster, and a layer that
    // another of its map takes picking from, by isPick, a link or a plot's mapRef.
    await expect(runSpec(page, zonesWith({ isPick: undefined, pickedComps: [1] })))
        .rejects.toThrow('Layer "Zones": pickedComps draws features as picked, which autk-map does only on the layer that picks: set isPick: true.');
    await expect(runSpec(page, zonesWith({ pickedComps: [1.5] })))
        .rejects.toThrow('Layer "Zones": pickedComps must list the positions of features the layer draws, whole numbers from 0, not [1.5].');
    await expect(runSpec(page, zonesWith({ pickedComps: [4] })))
        .rejects.toThrow('Layer "Zones": pickedComps names position 4, past the 4 features the layer draws.');
    await expect(runSpec(page, heatmapWith({ title: 'Heat', isPick: true, pickedComps: [0] })))
        .rejects.toThrow('Layer "Heat": pickedComps names features, and a raster layer has none.');
    await expect(runSpec(page, {
        data: [area, zones, blocks],
        map: { layerRefs: [{ dataRef: 'zones', title: 'Zones', isPick: true, pickedComps: [1] }, { dataRef: 'blocks', isPick: true }] },
    })).rejects.toThrow('Layer "Zones": pickedComps draws features as picked on the layer that picks, but layer "blocks", after it, picks too: autk-map lets one layer of a map pick, the last.');
    await expect(runSpec(page, zonesWith({ pickedComps: [1] }, {
        plot: plotOf({ id: 'p', dataRef: 'blocks', mark: 'scatter', axis: ['id', 'v'] }),
        links: [{ source: 'p', target: 'm' }],
    }))).rejects.toThrow(`Layer "Zones": pickedComps draws features as picked on the layer that picks, but a link or a plot's mapRef made layer "blocks" of its map pick: autk-map lets one layer of a map pick.`);
    await expect(runSpec(page, zonesWith({ pickedComps: [1] }, {
        plot: plotOf({ id: 'p', dataRef: 'zones', mark: 'scatter', axis: ['id', 'v'], selection: [0] }),
        links: [{ source: 'p', target: 'm', layer: 'Zones' }],
    }))).rejects.toThrow('Layer "Zones": pickedComps and the selection of plot "p", which is linked to it, both set what the two show: set one of them.');
});

test('draws the marks of every plot of the page in one markColor, and the selected ones in one highlightColor', async ({ page }) => {
    const green = 'rgb(44, 160, 44)'; // #2ca02c
    const red = 'rgb(214, 39, 40)'; // #d62728
    const fills = async (target: string) => (await plotMarks(page, target)).map(({ datum, fill }) => [datum?.id, fill]).sort();
    const zonesPlot = (fields: Record<string, unknown>) => plotOf({ dataRef: 'zones', axis: ['id', 'v'], ...fields });
    const plotStyle = () => page.evaluate(() => window.plotStyle());

    // A bar chart that sets both colors, and a scatter plot of the spec that sets neither and takes them too: each draws
    // its marks in the mark color, and its selected one in the highlight color.
    await runSpec(page, {
        data: [area, zones],
        plot: [
            zonesPlot({ id: 'a', mark: 'bar', markColor: '#2ca02c', highlightColor: '#d62728', selection: [1] }),
            zonesPlot({ id: 'b', mark: 'scatter', selection: [2] }),
        ],
    }, 'each');
    expect(await fills('plot0')).toEqual([[0, green], [1, red], [2, green], [3, green]]);
    expect(await fills('plot1')).toEqual([[0, green], [1, green], [2, red], [3, green]]);

    // A table draws its selected rows on the highlight color.
    await runSpec(page, { data: [trees], plot: plotOf({ id: 't', dataRef: 'trees', mark: 'table', axis: ['id', 'kind'], highlightColor: '#d62728', selection: [0] }) });
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#plot tr.autkMark'),
        (row) => [row.querySelector('td')?.textContent, getComputedStyle(row).backgroundColor]));
    expect(rows).toEqual([['a', red], ['b', 'rgba(0, 0, 0, 0)'], ['c', 'rgba(0, 0, 0, 0)'], ['d', 'rgba(0, 0, 0, 0)']]);

    // Two plots of one spec that set different mark colors are refused before anything is drawn.
    await expect(runSpec(page, {
        data: [area, zones],
        plot: [zonesPlot({ id: 'a', mark: 'bar', markColor: '#2ca02c' }), zonesPlot({ id: 'b', mark: 'bar', markColor: '#1f77b4' })],
    }, 'each')).rejects.toThrow('Plots "a" and "b" set different markColor values, "#2ca02c" and "#1f77b4": autk-plot draws every plot of a page in one mark color.');

    // The colors are the page's, and each run draws in its own spec's: a second grammar's run whose spec sets neither
    // draws in autk-plot's own colors, though the first grammar's still sets a mark color...
    await runSpec(page, { data: [area, zones], plot: zonesPlot({ id: 'a', mark: 'bar', markColor: '#2ca02c' }) });
    expect(await fills('plot')).toEqual([[0, green], [1, green], [2, green], [3, green]]);
    await page.evaluate((spec) => window.runBeside(spec), { data: [area, zones], plot: zonesPlot({ id: 'c', mark: 'bar', selection: [3] }) });
    expect(await fills('beside')).toEqual([[0, markGray], [1, markGray], [2, markGray], [3, highlightBlue]]);
    expect(await plotStyle()).toEqual({ markColor: '#bfbfbf', highlightColor: '#5dade2' });
    // ...which the first grammar's plot takes as it shows its next selection, since autk-plot keeps one of each for the
    // page. A later run that sets a mark color sets it for the page again.
    await page.evaluate(() => window.grammar.setPlotSelection('a', [1]));
    expect(await fills('plot')).toEqual([[0, markGray], [1, highlightBlue], [2, markGray], [3, markGray]]);
    await page.evaluate((spec) => window.runBeside(spec), { data: [area, zones], plot: zonesPlot({ id: 'c', mark: 'bar', markColor: '#1f77b4' }) });
    expect(await plotStyle()).toEqual({ markColor: '#1f77b4', highlightColor: '#5dade2' });
    expect(await fills('beside')).toEqual([[0, 'rgb(31, 119, 180)'], [1, 'rgb(31, 119, 180)'], [2, 'rgb(31, 119, 180)'], [3, 'rgb(31, 119, 180)']]);
    // A run that draws no plot, such as a page's data-only spec, leaves the page's colors as they are.
    await page.evaluate((spec) => window.runBeside(spec), { data: [area, zones] });
    expect(await plotStyle()).toEqual({ markColor: '#1f77b4', highlightColor: '#5dade2' });
});

test('colors the ten noisiest neighborhoods of plot-colors alike on its map and its chart, and selects the noisiest', async ({ page }) => {
    const spec = await exampleSpec(page, 'plot-colors');
    expect(spec.plot).toMatchObject({ colorMapInterpolator: 'interpolateReds', colorMapRange: [0, 80], selection: [0], highlightColor: '#1f77b4' });
    const { tables, plotSvgs } = await run(page, 'plot-colors');
    expect(tables.noisiest.features).toBe(10);
    expect(plotSvgs).toBe(1);
    await expectDrawn(page, 'map0');

    // The layer colors the counts over the range the chart colors them over.
    expect((await layerById(page))['Noise complaints']).toMatchObject({ isColorMap: true, interpolator: 'interpolateReds', domain: [0, 80] });
    const bars = await plotMarks(page);
    expect(bars).toHaveLength(10);
    const counts = bars.map(({ datum }) => Number(datum?.complaints));
    expect(counts.every((count) => count > 0)).toBe(true);
    // The first row, the noisiest neighborhood, is selected, in the chart's highlight color; each other bar is in the
    // color of its count over [0, 80].
    const [first, ...others] = bars;
    expect(Number(first.datum?.complaints)).toBe(Math.max(...counts));
    expect(first.fill).toBe('rgb(31, 119, 180)');
    for (const { datum, fill } of others)
        expect(fill, String(datum?.name)).toBe(await schemeFill(page, Number(datum?.complaints), 'interpolateReds', [0, 80]));
    // The link lights the same neighborhood on the map, and the chart titles its axes.
    const drawn = await page.evaluate(() => window.drawnRows('map0', 'Noise complaints'));
    const lit = (await layerById(page))['Noise complaints'].highlightedIds ?? [];
    expect(lit.map((position) => drawn[position]?.name)).toEqual([first.datum?.name]);
    expect(await page.evaluate(() => window.plotAxisTitles())).toEqual(['Neighborhood', 'Noise complaints']);
});

test("reads each building part's outline in a pass's fromFeature table, as a GeoJSON source in its workspace's CRS gave it", async ({ page }) => {
    // Three building parts, each 20 m wide, and four spots south of them, written in World Mercator meters, the
    // workspace's CRS, as a host that hands its own tables writes them. autk-db keeps each feature of a buildings table
    // in its building model, the geometry inside a GeometryCollection, where geometry.coordinates.0 finds no outline:
    // the pass packed three empty boxes, and every spot read a width of 0.
    const [x0, y0] = [-8235000, 4946000];
    const square = (x: number, y: number, size: number) =>
        ({ type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });
    const inMeters = (outputTableName: string, features: Array<{ properties: Record<string, unknown>; geometry: unknown }>, layerType?: string) => ({
        type: 'geojson', outputTableName, coordinateFormat: 'EPSG:3395', ...(layerType && { layerType }),
        geojsonObject: { type: 'FeatureCollection', features: features.map((feature) => ({ type: 'Feature', ...feature })) },
    });
    await runSpec(page, {
        data: [
            // autk-db cuts each table to the first polygon table it loads: a square kilometer around the others.
            inMeters('ground', [{ properties: {}, geometry: square(x0 - 500, y0 - 500, 1000) }]),
            inMeters('parts', [0, 1, 2].map((i) => ({ properties: { height: 10 + i }, geometry: square(x0 + i * 50, y0, 20) })), 'buildings'),
            inMeters('spots', [0, 1, 2, 3].map((i) => ({ properties: { w: 1 }, geometry: { type: 'Point', coordinates: [x0 + i * 40, y0 - 100] } }))),
        ],
        compute: [{
            dataRef: 'spots',
            attributes: { w: 'w' },
            uniformMatrices: { o: { fromFeature: { layer: 'parts', path: 'geometry.coordinates.0', iterate: 'batched' }, cols: 2 } },
            outputColumnName: 'width',
            // o packs [xmin,ymin, xmax,ymin, xmax,ymax, xmin,ymax] per part: sum the parts' widths.
            wgslFunction: [
                'var total = 0.0;',
                'for (var i = 0u; i < u32(num_features); i++) { total += o[i * 8u + 2u] - o[i * 8u]; }',
                'return total * w;',
            ],
        }],
    } as unknown as UrbanSpec);
    // Every spot reads the three parts' outlines in meters: 3 x 20 m.
    const widths = await page.evaluate(() => Promise.all([0, 1, 2, 3].map((i) => window.valueAt('spots', i, 'compute.width'))));
    expect(widths).toHaveLength(4);
    for (const width of widths) expect(width as number).toBeCloseTo(60, 3);
});

test('raises Manhattan in map-terrain to the heights of its elevation model, under its neighborhoods and elevation colors', async ({ page }) => {
    await run(page, 'map-terrain');
    const terrain = await page.evaluate(() => window.terrain('map0'));
    expect(terrain).toMatchObject({ band: 'band_1' });
    expect(terrain!.minHeight).toBeCloseTo(terrain!.bandMin, 3);
    expect(terrain!.maxHeight).toBeCloseTo(terrain!.bandMax, 3);
    // The model's 30 m cells: the island rises to about 80 m in Inwood.
    expect(terrain!.width * terrain!.height).toBeGreaterThan(400_000);
    expect(terrain!.maxHeight).toBeGreaterThan(60);
    expect((await mapLayers(page)).map((layer) => [layer.id, layer.type])).toEqual([['Neighborhoods', 'polygons'], ['Elevation (m)', 'raster']]);
    await expectDrawn(page, 'map0');
});
