import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type {
    CameraMotionStep, CameraSpec, ColorMapInterpolator, ComputeSpec, DataSourceSpec, GeoTiffDataSourceSpec, HeatmapSourceSpec, MapLayerSpec,
    MapSpec, PlotSpec, RenderComputeSpec, TerrainSpec, UrbanSpec,
} from '@urban-toolkit/the-urban-grammar';
import type { CameraView, DrawnMark, LayerState, PaneBox, RunSummary } from './app/main';
import { serveExtensions, type ExtensionRequests } from './duckdb-extensions';
import { spec as interactionExternal } from '../gallery/src/examples/interaction-external';
import { spec as heatmapGeojson } from '../gallery/src/examples/heatmap-vis-geojson';

// Runs gallery example specs end to end (data, compute, map, plot) so an Autark
// release that breaks the grammar fails here. See tests/README.md.

let pageErrors: string[] = [];
let adapterLogged = false;
let extensionRequests: ExtensionRequests = { served: [], missing: [] };

test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // DuckDB's extensions come from the tests' copy (tests/duckdb-extensions.ts), never from extensions.duckdb.org.
    extensionRequests = await serveExtensions(page);
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
    expect(extensionRequests.missing, 'DuckDB asked for extensions the tests\' copy does not hold: add them to EXTENSIONS in tests/duckdb-extensions.ts').toEqual([]);
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
    // DuckDB loads its extensions (spatial, then json) from extensions.duckdb.org. A run must not need that host, so this
    // run has it out of reach: every request to it fails as if the runner were offline.
    await page.context().route('https://extensions.duckdb.org/**', (route) => route.abort('internetdisconnected'));
    const { tables } = await run(page, 'load-multiple');
    expect(tables.noise.features).toBeGreaterThan(1000);
    expect(tables.noise.properties).toContain('Unique Key');
    // The tests' copy answered DuckDB's request for spatial, which autk-db loads as its database starts.
    expect(extensionRequests.served).toContain('spatial');
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
 * How many pixels of the map on #map0, or on #canvasId, are drawn in `color`, `#rrggbb`, give or take 8 in each
 * channel. The image is attached to the test as `<name>.png`.
 */
async function pixelsIn(page: Page, color: string, name: string, canvasId = 'map0'): Promise<number> {
    await page.waitForTimeout(1500);
    const dataUrl = await page.evaluate((id) => window.readMap(id), canvasId);
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

/**
 * How many pixels of the map on #map0, or on #canvasId, differ by more than 8 in some channel from the color most of
 * them have, the map's background: the pixels its features are drawn in. A map that drew nothing has none. The image is
 * attached to the test as `<name>.png`.
 */
async function drawnPixels(page: Page, name: string, canvasId = 'map0'): Promise<number> {
    await page.waitForTimeout(1500);
    const dataUrl = await page.evaluate((id) => window.readMap(id), canvasId);
    const image = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    await test.info().attach(`${name}.png`, { body: image, contentType: 'image/png' });
    const png = PNG.sync.read(image);
    const counts = new Map<number, number>();
    for (let i = 0; i < png.data.length; i += 4) {
        const color = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
        counts.set(color, (counts.get(color) ?? 0) + 1);
    }
    const [background] = [...counts].reduce((most, entry) => (entry[1] > most[1] ? entry : most));
    const [r, g, b] = [background >> 16, (background >> 8) & 255, background & 255];
    let drawn = 0;
    for (let i = 0; i < png.data.length; i += 4) {
        if (Math.abs(png.data[i] - r) > 8 || Math.abs(png.data[i + 1] - g) > 8 || Math.abs(png.data[i + 2] - b) > 8) drawn++;
    }
    return drawn;
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

test('draws the buildings that have no height with buildingsZeroHeight, each 3 to 7 floors tall, and leaves them out without it', async ({ page }) => {
    // Six footprints in a row: three 30 m tall, and three with none of height, building:height, levels and building:levels.
    const footprint = (i: number) => {
        const x = -73.99 + i * 0.004;
        return { type: 'Polygon' as const, coordinates: [[[x, 40.75], [x + 0.002, 40.75], [x + 0.002, 40.752], [x, 40.752], [x, 40.75]]] };
    };
    const footprints: DataSourceSpec = {
        type: 'geojson', outputTableName: 'footprints', layerType: 'buildings',
        geojsonObject: {
            type: 'FeatureCollection',
            features: [0, 1, 2, 3, 4, 5].map((i) => ({ type: 'Feature' as const, properties: i % 2 === 0 ? { id: i, height: 30 } : { id: i }, geometry: footprint(i) })),
        },
    };
    // The map looks straight down on the row from about 2.9 km, so each roof is about 56 by 74 pixels.
    const buildingsWith = (options: Partial<MapLayerSpec>): UrbanSpec => ({
        data: [area, footprints],
        map: { camera: { zoom: 11.8 }, layerRefs: [{ dataRef: 'footprints', title: 'Footprints', ...options }] },
    });
    const tops = () => page.evaluate(() => window.buildingTops('map0', 'Footprints'));
    const tall = (heights: Array<number | null>) => heights.filter((top) => top !== null && Math.abs(top - 30) < 1e-3);

    // Without it, autk-map draws the three that have a height and leaves out the others.
    await runSpec(page, buildingsWith({}));
    const without = await tops();
    expect(without).toHaveLength(6);
    expect(tall(without)).toHaveLength(3);
    expect(without.filter((top) => top === null)).toHaveLength(3);
    const threeRoofs = await drawnPixels(page, 'three buildings with a height');
    expect(threeRoofs, 'pixels of the three roofs').toBeGreaterThan(5000);

    // With it, the others stand too, each at a random height of 3 to 7 floors of 3.4 m: only that range is checked.
    await runSpec(page, buildingsWith({ buildingsZeroHeight: true }));
    const withIt = await tops();
    expect(tall(withIt)).toHaveLength(3);
    const fallback = withIt.filter((top) => top === null || Math.abs(top - 30) >= 1e-3);
    expect(fallback).toHaveLength(3);
    for (const top of fallback) {
        expect(top).not.toBeNull();
        expect(top!).toBeGreaterThanOrEqual(10.2 - 1e-3);
        expect(top!).toBeLessThanOrEqual(23.8 + 1e-3);
    }
    // The canvas shows them: six roofs of one size cover about twice the pixels of three.
    const sixRoofs = await drawnPixels(page, 'all six buildings');
    expect(sixRoofs, `six roofs cover ${sixRoofs} pixels, three ${threeRoofs}`).toBeGreaterThan(threeRoofs * 1.6);
});

test('draws a map in the colors of its style, and its picked features and the values it cannot color in its own colors', async ({ page }) => {
    // Four squares whose layer is colored by v, the third without one.
    const square = (i: number) => {
        const x = -73.99 + i * 0.004;
        return { type: 'Polygon' as const, coordinates: [[[x, 40.75], [x + 0.003, 40.75], [x + 0.003, 40.753], [x, 40.753], [x, 40.75]]] };
    };
    const gaps: DataSourceSpec = {
        type: 'geojson', outputTableName: 'gaps',
        geojsonObject: {
            type: 'FeatureCollection',
            features: [0, 1, 2, 3].map((i) => ({ type: 'Feature' as const, properties: i === 2 ? { id: i } : { id: i, v: i * 10 }, geometry: square(i) })),
        },
    };
    const colors = {
        background: '#102030', surface: '#203040', parks: '#2ca02c', water: '#1f77b4', roads: '#7f7f7f',
        buildings: '#8c564b', points: '#e377c2', polylines: '#bcbd22', polygons: '#d62728',
    };

    // A style of the spec's own: the background, and a layer without a color in the style's polygons color.
    await runSpec(page, { data: [area, zones], map: { style: colors, layerRefs: [{ dataRef: 'zones' }] } });
    expect(await pixelsIn(page, '#d62728', 'zones in the style')).toBeGreaterThan(400);
    expect(await pixelsIn(page, '#102030', 'background of the style')).toBeGreaterThan(10000);
    // A style by its name draws in that style's colors, not these.
    await runSpec(page, { data: [area, zones], map: { style: 'light', layerRefs: [{ dataRef: 'zones' }] } });
    expect(await pixelsIn(page, '#d62728', 'zones in light')).toBe(0);

    // highlightColor: the picked zones in orange rather than autk-map's blue.
    const picked = (highlightColor?: string): MapSpec => ({
        ...(highlightColor && { highlightColor }),
        layerRefs: [{ dataRef: 'zones', title: 'Zones', color: '#d9d9d9', isPick: true, pickedComps: [0, 2] }],
    });
    await runSpec(page, { data: [area, zones], map: picked('#ff7f0e') });
    expect(await pixelsIn(page, '#ff7f0e', 'picked in orange')).toBeGreaterThan(400);
    expect(await pixelsIn(page, '#5dade2', 'picked in orange, no blue')).toBe(0);
    // autk-map keeps one highlight color for each map, so two maps of one spec draw theirs.
    await runSpec(page, { data: [area, zones], map: [picked('#ff7f0e'), picked('#9467bd')] });
    expect(await pixelsIn(page, '#ff7f0e', 'orange on the first map')).toBeGreaterThan(400);
    expect(await pixelsIn(page, '#9467bd', 'no purple on the first map')).toBe(0);
    expect(await pixelsIn(page, '#9467bd', 'purple on the second map', 'map1')).toBeGreaterThan(400);
    expect(await pixelsIn(page, '#ff7f0e', 'no orange on the second map', 'map1')).toBe(0);

    // invalidValueColor: the square without a v in magenta, rather than autk-map's white.
    const byValue = (invalidValueColor?: string): UrbanSpec => ({
        data: [area, gaps],
        map: { ...(invalidValueColor && { invalidValueColor }), layerRefs: [{ dataRef: 'gaps', getFnv: 'v' }] },
    });
    await runSpec(page, byValue());
    expect(await pixelsIn(page, '#ff00ff', 'no value in white')).toBe(0);
    await runSpec(page, byValue('#ff00ff'));
    expect(await pixelsIn(page, '#ff00ff', 'no value in magenta')).toBeGreaterThan(400);

    // Refused before the map is made: a style that lacks a color or gives one autk-map cannot read, and colors not #rrggbb.
    const withoutParks = Object.fromEntries(Object.entries(colors).filter(([key]) => key !== 'parks'));
    await expect(runSpec(page, { data: [area, zones], map: { style: withoutParks as never, layerRefs: [{ dataRef: 'zones' }] } }))
        .rejects.toThrow(`Map 0: style gives no color for parks: a style of the spec's own gives each of background, surface, parks, water, roads, buildings, points, polylines, polygons.`);
    await expect(runSpec(page, { data: [area, zones], map: { style: { ...colors, water: 'blue' }, layerRefs: [{ dataRef: 'zones' }] } }))
        .rejects.toThrow('Map 0: style.water must be a color written #rrggbb, not "blue".');
    await expect(runSpec(page, { data: [area, zones], map: { ...picked('orange') } }))
        .rejects.toThrow('Map 0: highlightColor must be a color written #rrggbb, not "orange".');
    await expect(runSpec(page, byValue('#f0f')))
        .rejects.toThrow('Map 0: invalidValueColor must be a color written #rrggbb, not "#f0f".');
    expect(await page.evaluate(() => window.grammar.maps.length)).toBe(0);
});

test('hides the floating menu and legend of a map with showUi false, and keeps its credit', async ({ page }) => {
    const zonesWith = (showUi?: boolean): UrbanSpec => ({
        data: [area, zones],
        map: { ...(showUi !== undefined && { showUi }), layerRefs: [{ dataRef: 'zones', title: 'Zones', getFnv: 'v' }] },
    });
    const ui = () => page.evaluate(() => window.mapUi('map0'));

    // By default autk-map shows its menu, and the legend of the layer colored by value.
    await runSpec(page, zonesWith());
    expect(await ui()).toEqual({ menu: true, legend: true, credit: true });
    expect((await page.evaluate(() => window.legend()))?.visible).toBe(true);

    await runSpec(page, zonesWith(false));
    expect(await ui()).toEqual({ menu: false, legend: false, credit: true });
    expect(await page.evaluate(() => window.legend())).toBeNull();
    await expectDrawn(page, 'map0');

    await runSpec(page, zonesWith(true));
    expect(await ui()).toEqual({ menu: true, legend: true, credit: true });
});

test("shows the color scale of the layer that sets legend in the map's legend, and leaves picking as the layers set it", async ({ page }) => {
    // Zones valued 0 to 30 and lots valued 0 to 60, both colored by value; the lots pick.
    const twoScales = (zonesOptions: Partial<MapLayerSpec> = {}, lotsOptions: Partial<MapLayerSpec> = {}, mapOptions: Partial<MapSpec> = {}): UrbanSpec => ({
        data: [area, zones, lots],
        map: {
            ...mapOptions,
            layerRefs: [
                { dataRef: 'zones', title: 'Zones', getFnv: 'v', ...zonesOptions },
                { dataRef: 'lots', title: 'Lots', getFnv: 'v', isPick: true, ...lotsOptions },
            ],
        },
    });
    const legend = () => page.evaluate(() => window.legend());

    // By default the legend shows the last layer colored by value.
    await runSpec(page, twoScales());
    expect(await legend()).toMatchObject({ title: 'Lots', visible: true });

    // With legend on the zones: their scale, 0 to 30, while the lots still pick and the zones do not.
    await runSpec(page, twoScales({ legend: true }));
    expect(await legend()).toEqual({ title: 'Zones', labels: await page.evaluate((domain) => window.domainLabels(domain), [0, 30]), visible: true });
    const layers = await layerById(page);
    expect(layers.Lots.isPick).toBe(true);
    expect(layers.Zones.isPick).toBeFalsy();

    // A raster colored without a scheme of its own hides its legend, and shows it with legend.
    await runSpec(page, heatmapWith({}));
    expect((await legend())?.visible).toBe(false);
    await runSpec(page, heatmapWith({ legend: true }));
    expect(await legend()).toMatchObject({ title: 'heatmap', visible: true });

    // Refused: two legends in a map, a legend the map's showUi hides, and a layer drawn in one color.
    await expect(runSpec(page, twoScales({ legend: true }, { legend: true })))
        .rejects.toThrow('Map 0: layers "Zones" and "Lots" each set legend: a map shows one legend.');
    await expect(runSpec(page, twoScales({ legend: true }, {}, { showUi: false })))
        .rejects.toThrow(`Layer "Zones": legend shows the layer in the map's legend, and the map's showUi is false, which hides the legend.`);
    await expect(runSpec(page, twoScales({ legend: true, color: '#1f77b4' })))
        .rejects.toThrow('Layer "Zones": legend shows the color scale of a layer colored by value, and the layer is drawn in one color.');
});

test('hides the features skippedComps names, on a layer of polygons, of lines or of points', async ({ page }) => {
    const red = '#d62728';
    const drawnIn = async (dataRef: string, options: Partial<MapLayerSpec>, name: string) => {
        await runSpec(page, { data: [area, zones, paths, spots], map: { layerRefs: [{ dataRef, title: 'Hidden', color: red, ...options }] } });
        return pixelsIn(page, red, name);
    };

    // Two of the four zones hidden: about half of the red is left.
    const zonesShown = await drawnIn('zones', {}, 'every zone');
    const zonesLeft = await drawnIn('zones', { skippedComps: [0, 2] }, 'zones 0 and 2 hidden');
    expect((await layerById(page)).Hidden.skippedIds).toEqual([0, 2]);
    expect(zonesLeft).toBeGreaterThan(zonesShown * 0.3);
    expect(zonesLeft).toBeLessThan(zonesShown * 0.7);

    // Every line hidden, and every point, which AutkMap.setSkippedIds passes over.
    expect(await drawnIn('paths', { width: 40 }, 'every path')).toBeGreaterThan(100);
    expect(await drawnIn('paths', { width: 40, skippedComps: [0, 1, 2] }, 'no path')).toBe(0);
    expect(await drawnIn('spots', {}, 'every spot')).toBeGreaterThan(100);
    expect(await drawnIn('spots', { skippedComps: [0, 1, 2, 3, 4, 5, 6, 7, 8] }, 'no spot')).toBe(0);
    expect((await layerById(page)).Hidden.skippedIds).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    // Refused: positions that are not features the layer draws, and a raster.
    await expect(drawnIn('zones', { skippedComps: [-1] }, 'refused'))
        .rejects.toThrow('Layer "Hidden": skippedComps must list the positions of features the layer draws, whole numbers from 0, not [-1].');
    await expect(drawnIn('zones', { skippedComps: [4] }, 'refused'))
        .rejects.toThrow('Layer "Hidden": skippedComps names position 4, past the 4 features the layer draws.');
    await expect(runSpec(page, heatmapWith({ skippedComps: [0] })))
        .rejects.toThrow('Layer "heatmap": skippedComps names features, and a raster layer has none.');
});

test('draws each line of a roads layer as wide as widthBy says, and a line without a width as wide as its kind of road', async ({ page }) => {
    // Four east-west lines of one length: three with a width w, the fourth without one.
    const lanes = (widths: number[]): DataSourceSpec => ({
        type: 'geojson', outputTableName: 'lanes',
        geojsonObject: {
            type: 'FeatureCollection',
            features: [0, 1, 2, 3].map((i) => ({
                type: 'Feature' as const,
                properties: i < 3 ? { id: i, w: widths[i] } : { id: i },
                geometry: { type: 'LineString' as const, coordinates: [[-73.99, 40.748 - i * 0.003], [-73.975, 40.748 - i * 0.003]] },
            })),
        },
    });
    const red = '#d62728';
    const lanesWith = (widths: number[], options: Partial<MapLayerSpec>): UrbanSpec => ({
        data: [area, lanes(widths)],
        map: { layerRefs: [{ dataRef: 'lanes', title: 'Lanes', layerType: 'roads', color: red, ...options }] },
    });
    /** The width autk-map holds for each line, by its id. */
    const widthsById = async () => {
        const drawn = await page.evaluate(() => window.drawnRows('map0', 'Lanes'));
        const widths = (await layerById(page)).Lanes.polylinesWidthByComponent ?? [];
        return Object.fromEntries(drawn.map((row, position) => [String(row?.id), widths[position]]));
    };

    // Without widthBy, each line as wide as autk-map draws its kind of road.
    await runSpec(page, lanesWith([40, 120, 240], {}));
    const byKind = await widthsById();
    expect(Object.keys(byKind).sort()).toEqual(['0', '1', '2', '3']);

    // With it, the three widths, and the fourth line keeps its kind's.
    await runSpec(page, lanesWith([40, 120, 240], { widthBy: 'w' }));
    expect(await widthsById()).toEqual({ 0: 40, 1: 120, 2: 240, 3: byKind[3] });
    const varied = await pixelsIn(page, red, 'lines 40, 120 and 240 wide');
    // The same lines, 40 each: the varied ones cover over twice as many pixels, (40 + 120 + 240) / 120 being 3.3.
    await runSpec(page, lanesWith([40, 40, 40], { widthBy: 'properties.w' }));
    expect(await widthsById()).toEqual({ 0: 40, 1: 40, 2: 40, 3: byKind[3] });
    const even = await pixelsIn(page, red, 'lines 40 wide');
    expect(even).toBeGreaterThan(0);
    expect(varied).toBeGreaterThan(even * 2);

    // Refused: a polylines layer, whose lines autk-map draws at one width, widthBy with width, and a path to no width.
    await expect(runSpec(page, lanesWith([40, 120, 240], { layerType: undefined, widthBy: 'w' })))
        .rejects.toThrow(`Layer "Lanes": widthBy sets the width of each line of a roads layer, and the layer is drawn as polylines: draw a table of lines as roads with layerType: 'roads'.`);
    await expect(runSpec(page, lanesWith([40, 120, 240], { widthBy: 'w', width: 30 })))
        .rejects.toThrow('Layer "Lanes": set width or widthBy, not both: width gives every line one width.');
    await expect(runSpec(page, lanesWith([40, 120, 240], { widthBy: 'lanes' })))
        .rejects.toThrow('Layer "Lanes": widthBy "lanes" gives no line of the layer a width: none has a positive number there.');
});

test("reads widthBy at a key with dots in it, as a join writes an aggregate under '<table>.<column>', as getFnv is read", async ({ page }) => {
    // Three east-west lines, each with the width a join of pins would give it: sjoin.avg['pins.w'].
    const joined: DataSourceSpec = {
        type: 'geojson', outputTableName: 'lanes',
        geojsonObject: {
            type: 'FeatureCollection',
            features: [40, 120, 240].map((w, i) => ({
                type: 'Feature' as const,
                properties: { id: i, sjoin: { avg: { 'pins.w': w } } },
                geometry: { type: 'LineString' as const, coordinates: [[-73.99, 40.748 - i * 0.003], [-73.975, 40.748 - i * 0.003]] },
            })),
        },
    };
    await runSpec(page, {
        data: [area, joined],
        map: { layerRefs: [{ dataRef: 'lanes', title: 'Lanes', layerType: 'roads', widthBy: 'sjoin.avg.pins.w' }] },
    });
    const drawn = await page.evaluate(() => window.drawnRows('map0', 'Lanes'));
    const widths = (await layerById(page)).Lanes.polylinesWidthByComponent ?? [];
    expect(Object.fromEntries(drawn.map((row, position) => [String(row?.id), widths[position]]))).toEqual({ 0: 40, 1: 120, 2: 240 });
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
    // Like heatmaps, rasters are drawn on the map but not listed in the summary's tables. A vector layer over the
    // same area comes first, so it sets the map's origin; a raster loaded first sets it at its own middle.
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

test('draws a map whose only layer is a raster, from the middle of the raster, where autk-map 4.1.1 put its origin at [0, 0]', async ({ page }) => {
    // autk-map draws every layer of a map from one origin, the middle of the geometries of the first collection it loads.
    // A raster's one feature has no geometry, so autk-map before urban-toolkit/autark#125 put the origin at [0, 0], some
    // 9,600 km from a raster of Manhattan, and drew an empty canvas.
    await runSpec(page, { ...heatmapGeojson, map: { layerRefs: [{ dataRef: 'heatmap', getFnv: 'count.noise' }] } });
    await expectDrawn(page, 'map0');
    const [west, south, east, north] = await page.evaluate(() => window.handedBbox('map0', 'heatmap'));
    expect(await page.evaluate(() => window.mapOrigin('map0'))).toEqual([(west + east) * 0.5, (south + north) * 0.5]);
});

test("keeps a map's origin where its first vector layer puts it, with a raster after it", async ({ page }) => {
    // The origin comes from the first collection autk-map loads, so a raster after a vector layer leaves it there.
    await runSpec(page, { ...heatmapGeojson, map: { layerRefs: [{ dataRef: 'noise' }] } });
    const fromPoints = await page.evaluate(() => window.mapOrigin('map0'));
    await runSpec(page, { ...heatmapGeojson, map: { layerRefs: [{ dataRef: 'noise' }, { dataRef: 'heatmap', getFnv: 'count.noise' }] } });
    expect(await page.evaluate(() => window.mapOrigin('map0'))).toEqual(fromPoints);
    // The raster's middle lies elsewhere, so the origin is the points' and not the raster's.
    const [west, south, east, north] = await page.evaluate(() => window.handedBbox('map0', 'heatmap'));
    expect(fromPoints).not.toEqual([(west + east) * 0.5, (south + north) * 0.5]);
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

test("draws a layer's table as another type of its kind of geometry with layerType, and refuses a type of another kind", async ({ page }) => {
    // A style in which each type has a color of its own, so each layer shows in the color of the type it is drawn as.
    const palette = {
        background: '#ffffff', surface: '#ff0000', parks: '#00ff00', water: '#0000ff', roads: '#ff00ff',
        buildings: '#00ffff', points: '#808000', polylines: '#800080', polygons: '#008080',
    };
    // A row of footprints loaded as a buildings table, and a row of squares 50 m tall loaded as polygons.
    const row = (name: string, y: number, properties: Record<string, unknown>, layerType?: 'buildings'): DataSourceSpec => ({
        type: 'geojson', outputTableName: name, ...(layerType && { layerType }),
        geojsonObject: {
            type: 'FeatureCollection',
            features: [0, 1, 2].map((i) => {
                const x = -73.99 + i * 0.004;
                return {
                    type: 'Feature' as const, properties: { id: i, ...properties },
                    geometry: { type: 'Polygon' as const, coordinates: [[[x, y], [x + 0.002, y], [x + 0.002, y + 0.002], [x, y + 0.002], [x, y]]] },
                };
            }),
        },
    });
    const footprints = row('footprints', 40.768, { height: 20 }, 'buildings');
    const towers = row('towers', 40.739, { height: 50 });
    await runSpec(page, {
        data: [area, zones, blocks, lots, paths, footprints, towers],
        map: {
            style: palette,
            layerRefs: [
                { dataRef: 'zones', layerType: 'parks' },
                { dataRef: 'blocks', layerType: 'water' },
                { dataRef: 'lots', layerType: 'surface' },
                { dataRef: 'paths', layerType: 'roads', width: 60 },
                { dataRef: 'footprints', layerType: 'polygons' },
                { dataRef: 'towers', layerType: 'buildings' },
            ],
        },
    });
    const types = Object.fromEntries((await mapLayers(page)).map((layer) => [layer.id, layer.type]));
    expect(types).toEqual({ zones: 'parks', blocks: 'water', lots: 'surface', paths: 'roads', footprints: 'polygons', towers: 'buildings' });
    expect(await pixelsIn(page, palette.parks, 'polygons as parks')).toBeGreaterThan(400);
    expect(await pixelsIn(page, palette.water, 'polygons as water')).toBeGreaterThan(400);
    expect(await pixelsIn(page, palette.surface, 'polygons as surface')).toBeGreaterThan(400);
    expect(await pixelsIn(page, palette.roads, 'lines as roads')).toBeGreaterThan(100);
    expect(await pixelsIn(page, palette.polygons, 'buildings flat as polygons')).toBeGreaterThan(100);
    expect(await pixelsIn(page, palette.polylines, 'no line drawn as polylines')).toBe(0);
    // The polygons drawn as buildings rise to their heights.
    expect(await page.evaluate(() => window.buildingTops('map0', 'towers'))).toEqual([50, 50, 50]);

    // A type of another kind of geometry is refused before autk-map draws nothing for it.
    const refused = (layerRef: MapLayerSpec, message: string) => expect(runSpec(page, {
        data: [area, zones, paths, spots], map: { layerRefs: [layerRef] },
    })).rejects.toThrow(message);
    await refused({ dataRef: 'zones', layerType: 'points' },
        'Layer "zones": layerType "points" cannot draw the table "zones", a polygons table: a table of polygons is drawn as polygons, surface, parks, water or buildings.');
    await refused({ dataRef: 'paths', layerType: 'parks' },
        'Layer "paths": layerType "parks" cannot draw the table "paths", a polylines table: a table of lines is drawn as polylines or roads.');
    await refused({ dataRef: 'spots', layerType: 'polygons' },
        'Layer "spots": layerType "polygons" cannot draw the table "spots", a points table: a table of points is drawn as points.');
    await expect(runSpec(page, heatmapWith({ layerType: 'polygons' })))
        .rejects.toThrow('Layer "heatmap": layerType "polygons" cannot draw the table "heatmap", a raster table: a raster table is drawn as raster.');
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

test("places buildings' windows in a table of their own, the points a building-windows render pass renders from", async ({ page }) => {
    const { tables } = await runSpec(page, {
        ...boxSpec({ bbox: BOX }),
        compute: [
            { type: 'windows', dataRef: 'box_buildings', floors: 2, outputTableName: 'windows' },
            {
                type: 'render',
                outputTableName: 'seen',
                layers: [{ id: 'buildings', dataRef: 'box_buildings', type: 'buildings' }],
                viewpoints: { dataRef: 'box_buildings', strategy: { type: 'building-windows', floors: 2 } },
                aggregation: { type: 'classes', includeBackground: true },
                tileSize: 8,
            },
        ],
        // Framed on the box, as compute-render frames it, with the windows small and colored by their building's height,
        // so each wall shows; from autk-map's own view the box is a speck, and its windows one gray disc.
        map: {
            camera: { zoom: 13.8 },
            layerRefs: [
                { dataRef: 'box_surface' },
                { dataRef: 'box_roads' },
                { dataRef: 'windows', getFnv: 'buildingHeight', colorMapInterpolator: scheme('interpolateInferno'), pointSize: 2 },
            ],
        },
    });
    // The same windows, in the same order: their ids, points, buildings and floors.
    const { windows, seen } = await page.evaluate(async () => {
        const read = async (table: string) => (await window.grammar.data[table]).features.map((feature) => ({
            id: feature.id,
            at: (feature.geometry as { coordinates: number[] }).coordinates,
            building: feature.properties?.sourceFeatureIndex,
            floor: feature.properties?.floorIndex,
            render: feature.properties?.compute?.render !== undefined,
        }));
        return { windows: await read('windows'), seen: await read('seen') };
    });
    expect(windows.length).toBeGreaterThan(tables.box_buildings.features);
    const placed = (list: typeof windows) => list.map(({ id, at, building, floor }) => ({ id, at, building, floor }));
    expect(placed(windows)).toEqual(placed(seen));
    // Each a point at the middle of a window, on one of two floors, with no render metrics.
    expect(windows.every((point) => point.at.length === 3 && point.at[2] > 0)).toBe(true);
    expect([...new Set(windows.map((point) => point.floor))].sort()).toEqual([0, 1]);
    expect(windows.filter((point) => point.render)).toEqual([]);
    expect(seen.every((point) => point.render)).toBe(true);
    // The buildings stay as they are, and the map draws the windows as points, colored by value.
    expect(await page.evaluate(() => window.valueAt('box_buildings', 0, 'floorIndex'))).toBeUndefined();
    expect((await mapLayers(page)).map((layer) => [layer.id, layer.type, layer.isColorMap ?? false]))
        .toEqual([['box_surface', 'surface', false], ['box_roads', 'roads', false], ['windows', 'points', true]]);
    await expectDrawn(page, 'map0');

    // A table of points has no facades to place windows on, and the pass says so.
    await expect(runSpec(page, {
        data: [area, spots],
        compute: [{ type: 'windows', dataRef: 'spots', floors: 1, outputTableName: 'w' }],
    })).rejects.toThrow('Windows pass "w": autk-core places no windows on "spots"');
});

test('writes the cluster of touching geometries to a column, in place or into a new table', async ({ page }) => {
    // Four squares inside area: a and b share an edge, c stands apart, and d touches c at a corner only.
    const square = (name: string, x: number, y: number) => ({
        type: 'Feature' as const,
        properties: { name },
        geometry: { type: 'Polygon' as const, coordinates: [[[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y + 0.001], [x, y]]] },
    });
    const blocks: DataSourceSpec = {
        type: 'geojson',
        outputTableName: 'blocks',
        geojsonObject: {
            type: 'FeatureCollection',
            features: [square('a', -73.99, 40.75), square('b', -73.989, 40.75), square('c', -73.985, 40.75), square('d', -73.984, 40.751)],
        },
    };
    const clustersOf = (table: string, column: string) => page.evaluate(async ([name, key]) =>
        Object.fromEntries((await window.grammar.data[name]).features.map((feature) =>
            [feature.properties?.name, feature.properties?.compute?.[key] ?? null])), [table, column] as const);

    // Into a new table, which the map draws as the table it was computed from; the blocks stay as they are.
    await runSpec(page, {
        data: [area, blocks],
        compute: [{ type: 'clusters', dataRef: 'blocks', outputColumnName: 'cluster', outputTableName: 'joined' }],
        map: { layerRefs: [{ dataRef: 'joined', getFnv: 'compute.cluster' }] },
    });
    const joined = await clustersOf('joined', 'cluster');
    expect(joined.a).toBe(joined.b);
    expect(joined.c).toBe(joined.d);
    expect(joined.a).not.toBe(joined.c);
    expect([joined.a, joined.c].sort()).toEqual([0, 1]);
    // The first row's cluster is 0.
    expect(await page.evaluate(() => window.valueAt('joined', 0, 'compute.cluster'))).toBe(0);
    expect(await clustersOf('blocks', 'cluster')).toEqual({ a: null, b: null, c: null, d: null });
    expect((await mapLayers(page)).map((layer) => [layer.id, layer.type, layer.isColorMap])).toEqual([['joined', 'polygons', true]]);

    // In place, beside the column of an earlier pass.
    await runSpec(page, {
        data: [area, blocks],
        compute: [
            { type: 'clusters', dataRef: 'blocks', outputColumnName: 'first' },
            { type: 'clusters', dataRef: 'blocks', outputColumnName: 'second' },
        ],
    });
    expect(await clustersOf('blocks', 'second')).toEqual(await clustersOf('blocks', 'first'));
    expect(await clustersOf('blocks', 'first')).toEqual(joined);

    // The buildings around Wall Street: walls shared along a block put many in one cluster.
    await runSpec(page, { ...boxSpec({ bbox: BOX }), compute: [{ type: 'clusters', dataRef: 'box_buildings', outputColumnName: 'block' }] });
    const ids = await page.evaluate(async () =>
        (await window.grammar.data.box_buildings).features.map((feature) => feature.properties?.compute?.block as number));
    const clusters = [...new Set(ids)].sort((a, b) => a - b);
    expect(ids.every((id) => Number.isInteger(id) && id >= 0), 'every building has a cluster').toBe(true);
    expect(clusters, 'the ids run from 0 with no gap').toEqual(clusters.map((_, i) => i));
    expect(clusters.length, 'buildings that share walls share a cluster').toBeLessThan(ids.length);
    expect(ids[0]).toBe(0);
});

// writeBack keeps a pass's result in autk-db too. window.dbRows and window.dbLayer read autk-db's own tables, apart from
// the grammar's caches, which maps, plots and grammar.data read first.

/** A square 0.001 degrees across, its south-west corner at (x, y), named `name`. */
function squareAt(name: string, x: number, y: number) {
    return {
        type: 'Feature' as const,
        properties: { name },
        geometry: { type: 'Polygon' as const, coordinates: [[[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y + 0.001], [x, y]]] },
    };
}

/** Four squares inside `area`: a and b share an edge, c stands apart, and d touches c at a corner only. */
const fourSquares: DataSourceSpec = {
    type: 'geojson',
    outputTableName: 'squares',
    geojsonObject: {
        type: 'FeatureCollection',
        features: [squareAt('a', -73.99, 40.75), squareAt('b', -73.989, 40.75), squareAt('c', -73.985, 40.75), squareAt('d', -73.984, 40.751)],
    },
};

/** The cluster each square of `table` has in autk-db, in its compute column `column`, by the square's name. */
function clustersInDb(page: Page, table: string, column: string): Promise<Array<Record<string, unknown>>> {
    return page.evaluate(([name, key]) => window.dbRows(
        `SELECT properties->>'name' AS name, CAST(properties->'compute'->>'${key}' AS INTEGER) AS cluster FROM ${name} ORDER BY name`,
    ), [table, column] as const);
}

test('keeps a pass\'s result in autk-db with writeBack, in place and as a new table, and only with it', async ({ page }) => {
    const passes = (writeBack?: boolean): ComputeSpec[] => [
        { type: 'clusters', dataRef: 'squares', outputColumnName: 'cluster', ...(writeBack !== undefined && { writeBack }) },
        { type: 'clusters', dataRef: 'squares', outputColumnName: 'group', outputTableName: 'joined', ...(writeBack !== undefined && { writeBack }) },
    ];
    const tables = (name: string) => page.evaluate((table) => window.dbRows(`SELECT count(*) AS n FROM information_schema.tables WHERE table_name = '${table}'`), name);

    // Without it, the results are in the grammar's cache alone: autk-db's squares have no cluster, and autk-db holds no
    // table `joined`.
    for (const writeBack of [undefined, false]) {
        await runSpec(page, { data: [area, fourSquares], compute: passes(writeBack) });
        expect(await valuesOf(page, 'squares', 4, 'compute.cluster')).toEqual([0, 0, 1, 1]);
        expect(await clustersInDb(page, 'squares', 'cluster')).toEqual(['a', 'b', 'c', 'd'].map((name) => ({ name, cluster: null })));
        expect(await tables('joined')).toEqual([{ n: 0 }]);
    }

    // With it, autk-db holds what the cache holds: the squares, each in its cluster, and the new table, which the second
    // pass computed from the first's result, so it has both columns.
    await runSpec(page, { data: [area, fourSquares], compute: passes(true) });
    const clusters = [{ name: 'a', cluster: 0 }, { name: 'b', cluster: 0 }, { name: 'c', cluster: 1 }, { name: 'd', cluster: 1 }];
    expect(await valuesOf(page, 'squares', 4, 'compute.cluster')).toEqual([0, 0, 1, 1]);
    expect(await clustersInDb(page, 'squares', 'cluster')).toEqual(clusters);
    expect(await clustersInDb(page, 'joined', 'group')).toEqual(clusters);
    expect(await clustersInDb(page, 'joined', 'cluster')).toEqual(clusters);
    // The squares keep their rows and properties, and the new table is a layer of the squares' type.
    expect(await page.evaluate(() => window.dbRows("SELECT count(*) AS n, count(DISTINCT properties->>'name') AS names FROM squares"))).toEqual([{ n: 4, names: 4 }]);
    expect(await page.evaluate(() => window.dbRows("SELECT ST_GeometryType(geometry) AS type, count(*) AS n FROM joined GROUP BY type"))).toEqual([{ type: 'POLYGON', n: 4 }]);
});

test('writes every window of a windows pass back, each on the workspace grid, though autk-db cuts a loaded table to the workspace', async ({ page }) => {
    // A 1 m grid in Web Mercator. `site` is the first polygon table, so autk-db cuts each table a source loads after it
    // to it. The east building reaches past the site's east edge; autk-db keeps a building whole.
    const site: DataSourceSpec = {
        type: 'geojson',
        outputTableName: 'site',
        geojsonObject: {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-73.99, 40.75], [-73.985, 40.75], [-73.985, 40.753], [-73.99, 40.753], [-73.99, 40.75]]] } }],
        },
    };
    const building = (x: number) => ({
        type: 'Feature' as const,
        properties: { height: 12 },
        geometry: { type: 'Polygon' as const, coordinates: [[[x, 40.751], [x + 0.001, 40.751], [x + 0.001, 40.7515], [x, 40.7515], [x, 40.751]]] },
    });
    const buildings: DataSourceSpec = {
        type: 'geojson',
        outputTableName: 'buildings',
        layerType: 'buildings',
        geojsonObject: { type: 'FeatureCollection', features: [building(-73.989), building(-73.9855)] },
    };
    const workspaces = [{ coordinateFormat: 'EPSG:3857', precisionGrid: 1 }];
    await runSpec(page, {
        workspaces,
        data: [site, buildings],
        compute: [{ type: 'windows', dataRef: 'buildings', floors: 2, outputTableName: 'windows', writeBack: true }],
    });
    const windows = await page.evaluate(async () => await window.grammar.data.windows);
    const positions = windows.features.map((feature) => (feature.geometry as { coordinates: number[] }).coordinates);

    // autk-db holds every window, those outside the site too, each on the 1 m grid, where the pass placed many between.
    expect(await page.evaluate(() => window.dbRows('SELECT count(*) AS n FROM windows'))).toEqual([{ n: windows.features.length }]);
    const [{ outside }] = await page.evaluate(() =>
        window.dbRows('SELECT count(*) AS outside FROM windows WHERE NOT ST_Intersects(geometry, (SELECT ST_Union_Agg(geometry) FROM site))'));
    expect(outside, 'windows outside the site').toBeGreaterThan(0);
    expect(positions.some(([x, y]) => !Number.isInteger(x) || !Number.isInteger(y)), 'windows off the grid in the cache').toBe(true);
    expect(await page.evaluate(() =>
        window.dbRows('SELECT count(*) AS n FROM windows WHERE ST_X(geometry) <> round(ST_X(geometry)) OR ST_Y(geometry) <> round(ST_Y(geometry))')))
        .toEqual([{ n: 0 }]);

    // Loaded by a source into the same workspace, the same windows are cut to the site, which writeBack does not do.
    await runSpec(page, {
        workspaces,
        data: [site, buildings, { type: 'geojson', outputTableName: 'loaded', coordinateFormat: 'EPSG:3857', geojsonObject: windows as never }],
    });
    const [{ n: loaded }] = await page.evaluate(() => window.dbRows('SELECT count(*) AS n FROM loaded'));
    expect(loaded, 'windows a source keeps').toBeGreaterThan(0);
    expect(loaded, 'windows a source keeps').toBeLessThan(windows.features.length);
});

test('writes a pass back in place into an OSM table, which keeps its buildings, and whose element records autk-db clears', async ({ page }) => {
    const spec = (writeBack: boolean): UrbanSpec => ({
        ...boxSpec({ bbox: BOX }),
        compute: [{ type: 'clusters', dataRef: 'box_buildings', outputColumnName: 'block', writeBack }],
    });
    /** The rows autk-db exports, or with osmElements its OSM elements: their ids, and each row's parts and block. */
    const exported = (osmElements: boolean) => page.evaluate(async (elements) => (await window.dbLayer('box_buildings', elements)).features.map((feature) => ({
        id: feature.id,
        parts: feature.geometry?.type === 'GeometryCollection' ? feature.geometry.geometries.length : 1,
        block: feature.properties?.compute?.block ?? null,
    })), osmElements);

    // Without writeBack, autk-db's table is the one it loaded: osmElements exports one feature per OSM element.
    await runSpec(page, spec(false));
    const rows = await exported(false);
    expect(rows.every((row) => row.block === null)).toBe(true);
    expect((await exported(true)).length, 'OSM elements').toBeGreaterThan(rows.length);

    // With it, each building keeps its parts and gains the block the grammar's cache gives it.
    await runSpec(page, spec(true));
    const written = await exported(false);
    const cached = await page.evaluate(async () => (await window.grammar.data.box_buildings).features.map((feature) => feature.properties?.compute?.block));
    expect(written.map(({ id, parts }) => ({ id, parts }))).toEqual(rows.map(({ id, parts }) => ({ id, parts })));
    expect(written.map((row) => row.block)).toEqual(cached);
    // autk-db clears the records of the OSM elements on any update, so osmElements then exports the rows.
    expect(await exported(true)).toEqual(written);
});

test('draws and plots the OSM elements of a table a pass changed in place with osmElements, as autk-db holds them', async ({ page }) => {
    // A pass in place keeps its result in the grammar's cache, which maps and plots read first, and leaves autk-db's
    // records of the table's elements as they were. osmElements read the pass's rows: a plot of the elements refused
    // its osm_type axis, and the layer drew the buildings by their blocks.
    await runSpec(page, {
        ...boxSpec({ bbox: BOX }),
        compute: [{ type: 'clusters', dataRef: 'box_buildings', outputColumnName: 'block' }],
        map: { layerRefs: [{ dataRef: 'box_buildings', title: 'Building parts', osmElements: true }] },
        plot: { dataRef: 'box_buildings', mark: 'table', axis: ['osm_type', 'osm_id'], osmElements: true },
    });
    // The pass ran: the grammar's copy of the table gives each building its block.
    const blocks = await page.evaluate(async () => (await window.grammar.data.box_buildings).features.map((feature) => feature.properties?.compute?.block));
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.filter((block) => !Number.isInteger(block))).toEqual([]);
    // Each part the layer draws is an element that names its building, without a block.
    const parts = await page.evaluate(() => window.drawnRows('map0', 'Building parts'));
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.filter((row) => !['way', 'relation'].includes(String(row?.osm_type)) || row?.building_id == null || row?.compute !== undefined)).toEqual([]);
    // The plot lists every element autk-db exports, more than the table's rows.
    const elements = await page.evaluate(async () => (await window.dbLayer('box_buildings', true)).features.map((feature) => feature.properties?.osm_id));
    expect(elements.length).toBeGreaterThan(blocks.length);
    const plotted = await page.evaluate(() => [...document.querySelectorAll('#plot tr.autkMark')]
        .map((row) => (row as Element & { __data__?: { osm_id?: number } }).__data__?.osm_id));
    const ascending = (ids: unknown[]) => ids.map(Number).sort((a, b) => a - b);
    expect(ascending(plotted)).toEqual(ascending(elements));
    await expectDrawn(page, 'map0');
});

test('reads a table a pass changed in place as without osmElements where autk-db gives no elements: after a write-back, a GeoJSON table, a table only a pass wrote', async ({ page }) => {
    // autk-db exports such a table row by row (a write-back in place clears its element records, as any update does),
    // or holds no table of its name, so the layer draws the pass's rows, as it does without osmElements.
    const drawn = (layerId: string, column: string) => page.evaluate(([id, key]) => window.drawnRows('map0', id)
        .map((row) => ({ value: (row?.compute as Record<string, unknown> | undefined)?.[key], element: row?.osm_id !== undefined })), [layerId, column] as const);
    const passRows = (rows: Array<{ value: unknown; element: boolean }>) => rows.length > 0 && rows.every(({ value, element }) => Number.isInteger(value) && !element);

    await runSpec(page, {
        ...boxSpec({ bbox: BOX }),
        compute: [{ type: 'clusters', dataRef: 'box_buildings', outputColumnName: 'block', writeBack: true }],
        map: { layerRefs: [{ dataRef: 'box_buildings', title: 'Buildings', osmElements: true }] },
    });
    expect(passRows(await drawn('Buildings', 'block')), 'an OSM table written back in place').toBe(true);

    await runSpec(page, {
        data: [area, fourSquares],
        compute: [{ type: 'clusters', dataRef: 'squares', outputColumnName: 'cluster' }],
        map: { layerRefs: [{ dataRef: 'squares', osmElements: true }] },
    });
    expect(passRows(await drawn('squares', 'cluster')), 'a GeoJSON table changed in place').toBe(true);

    await runSpec(page, {
        data: [area, fourSquares],
        compute: [{ type: 'clusters', dataRef: 'squares', outputColumnName: 'cluster', outputTableName: 'blocks' }],
        map: { layerRefs: [{ dataRef: 'blocks', osmElements: true }] },
    });
    expect(passRows(await drawn('blocks', 'cluster')), 'a table only a pass wrote').toBe(true);
});

// Sources with after: 'compute' run once every pass has run, and read what passes kept in autk-db with writeBack.

/** Pins: two in square a, one in square c, none in b or d. */
const pins: DataSourceSpec = {
    type: 'geojson',
    outputTableName: 'pins',
    geojsonObject: {
        type: 'FeatureCollection',
        features: [[-73.9895, 40.7505], [-73.9894, 40.7506], [-73.9845, 40.7505]].map(([x, y]) =>
            ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [x, y] } })),
    },
};

test("joins after compute into a table a pass wrote back, and from one by a compute column, and draws what the joins wrote", async ({ page }) => {
    await runSpec(page, {
        data: [
            // Listed before the sources they read, the joins run after them and after the pass, in this order.
            { type: 'join', dataRef: 'squares', joinDataRef: 'pins', groupBy: [{ column: '*', aggregateFn: 'count' }], after: 'compute' },
            { type: 'join', dataRef: 'zones', joinDataRef: 'squares', groupBy: [{ column: 'compute.cluster', aggregateFn: 'max' }], after: 'compute' },
            area, zones, fourSquares, pins,
        ],
        compute: [{ type: 'clusters', dataRef: 'squares', outputColumnName: 'cluster', writeBack: true }],
        map: [
            { layerRefs: [{ dataRef: 'squares', getFnv: 'sjoin.count.pins' }] },
            { layerRefs: [{ dataRef: 'zones', getFnv: 'sjoin.max.squares.compute.cluster' }] },
        ],
    });
    // The squares hold the pass's clusters and the join's counts together: grammar.data and the map read autk-db's
    // table, not the pass's result the join changed.
    const squares = await page.evaluate(async () => Object.fromEntries((await window.grammar.data.squares).features.map((feature) =>
        [feature.properties?.name, [feature.properties?.compute?.cluster, feature.properties?.sjoin?.count?.pins]])));
    expect(squares).toEqual({ a: [0, 2], b: [0, 0], c: [1, 1], d: [1, 0] });
    const drawn = await page.evaluate(() => window.drawnRows('map0', 'squares').map((row) =>
        `${row?.name} ${(row?.compute as { cluster?: number })?.cluster} ${(row?.sjoin as { count?: { pins?: number } })?.count?.pins}`));
    expect(drawn.sort()).toEqual(['a 0 2', 'b 0 0', 'c 1 1', 'd 1 0']);
    // Zone 0 covers a and b, zone 1 c and d: the greatest cluster among the squares each covers, under the key autk-db
    // writes, `<joinDataRef>.<column>`, which a layer's getFnv reads as a path.
    const zoneClusters = await page.evaluate(async () => (await window.grammar.data.zones).features.map((feature) =>
        [feature.properties?.id, feature.properties?.sjoin?.max?.['squares.compute.cluster'] ?? null]));
    expect(zoneClusters.sort()).toEqual([[0, 0], [1, 1], [2, null], [3, null]]);
    const zoneLayer = (await mapLayers(page, 'map1')).find((layer) => layer.id === 'zones');
    expect([zoneLayer?.isColorMap, zoneLayer?.domain]).toEqual([true, [0, 1]]);
});

test('builds a heatmap after compute from the windows a pass wrote back', async ({ page }) => {
    const buildings: DataSourceSpec = {
        type: 'geojson',
        outputTableName: 'buildings',
        layerType: 'buildings',
        geojsonObject: { type: 'FeatureCollection', features: [squareAt('north', -73.99, 40.76), squareAt('south', -73.98, 40.75)].map((feature) =>
            ({ ...feature, properties: { ...feature.properties, height: 15 } })) },
    };
    await runSpec(page, {
        data: [area, buildings, {
            type: 'heatmap', outputTableName: 'heat', joinDataRef: 'windows', near: { distance: 10000 }, grid: { rows: 1, columns: 1 },
            groupBy: [{ column: '*', aggregateFn: 'count' }], after: 'compute',
        }],
        compute: [{ type: 'windows', dataRef: 'buildings', floors: 2, outputTableName: 'windows', writeBack: true }],
        map: { layerRefs: [{ dataRef: 'area' }, { dataRef: 'heat' }] },
    });
    // One cell, within reach of every window: it counts them all.
    const windows = await page.evaluate(async () => (await window.grammar.data.windows).features.length);
    expect(windows).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.handedBand('map0', 'heat', 'band_1'))).toEqual([windows]);
});

test('queries a table a pass wrote back with a sql source after compute, and plots its rows', async ({ page }) => {
    await runSpec(page, {
        data: [area, fourSquares, {
            type: 'sql',
            outputTableName: 'sizes',
            query: "SELECT CAST(properties->'compute'->>'block' AS INTEGER) AS block, CAST(count(*) AS INTEGER) AS squares FROM blocks GROUP BY block ORDER BY block",
            after: 'compute',
        }],
        compute: [{ type: 'clusters', dataRef: 'squares', outputColumnName: 'block', outputTableName: 'blocks', writeBack: true }],
        plot: { dataRef: 'sizes', mark: 'bar', axis: ['block', 'squares'] },
    });
    const bars = await page.evaluate(() => [...document.querySelectorAll('#plot rect.autkMark')]
        .map((bar) => (bar as Element & { __data__?: { block?: number; squares?: number } }).__data__)
        .map((datum) => `${datum?.block} ${datum?.squares}`));
    expect(bars.sort()).toEqual(['0 2', '1 2']);
});

test('refuses a source after compute that reads a table a pass wrote without writeBack, and an after other than compute', async ({ page }) => {
    const join: DataSourceSpec = { type: 'join', dataRef: 'squares', joinDataRef: 'pins', after: 'compute' };
    await expect(runSpec(page, {
        data: [area, fourSquares, pins, join],
        compute: [{ type: 'clusters', dataRef: 'squares', outputColumnName: 'cluster' }],
    })).rejects.toThrow('Data source 3 (join) runs after compute and reads "squares", which compute pass 0 writes without writeBack, so autk-db holds "squares" without that pass\'s result. Set writeBack: true on the pass.');
    await expect(runSpec(page, { data: [area, { ...fourSquares, after: 'map' } as never] }))
        .rejects.toThrow(`Data source 1 (geojson): after must be 'compute', the one phase a source runs after, not "map".`);
});

// A host runs a spec's sources and passes on an autk-db database of its own with createComputeSteps, and reads each pass's
// result as the grammar holds it with computed. window.runOnHostDb runs the steps on a database the page makes, and
// window.hostRows reads that database.

test("runs passes written back and sources after compute on a database the host owns, with createComputeSteps, as a run does", async ({ page }) => {
    // Written in World Mercator meters, the default workspace's CRS, as a host that hands its own tables writes them.
    const [x0, y0] = [-8235000, 4946000];
    const square = (x: number, y: number, size: number) =>
        ({ type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });
    const point = (x: number, y: number) => ({ type: 'Point', coordinates: [x, y] });
    const inMeters = (outputTableName: string, features: Array<{ properties: Record<string, unknown>; geometry: unknown }>, layerType?: string) => ({
        type: 'geojson', outputTableName, coordinateFormat: 'EPSG:3395', ...(layerType && { layerType }),
        geojsonObject: { type: 'FeatureCollection', features: features.map((feature) => ({ type: 'Feature', ...feature })) },
    });
    const spec = {
        data: [
            // Listed first, the sources after compute run once both passes have, in this order.
            {
                type: 'sql', outputTableName: 'totals', after: 'compute',
                query: "SELECT CAST(count(*) AS INTEGER) AS spots, sum(CAST(properties->'compute'->>'width' AS DOUBLE)) AS width FROM widths",
            },
            { type: 'join', dataRef: 'squares', joinDataRef: 'pins', groupBy: [{ column: '*', aggregateFn: 'count' }], after: 'compute' },
            // autk-db cuts each table to the first polygon table it loads: a square kilometer around the others.
            inMeters('ground', [{ properties: {}, geometry: square(x0 - 500, y0 - 500, 1000) }]),
            // Three building parts, each 20 m wide, and four spots south of them.
            inMeters('parts', [0, 1, 2].map((i) => ({ properties: { height: 10 + i }, geometry: square(x0 + i * 50, y0, 20) })), 'buildings'),
            inMeters('spots', [0, 1, 2, 3].map((i) => ({ properties: { w: 1 }, geometry: point(x0 + i * 40, y0 - 100) }))),
            // Squares a and b share an edge, and c stands apart; two pins lie in a, and one in c.
            inMeters('squares', [0, 60, 300].map((dx, i) => ({ properties: { name: 'abc'[i] }, geometry: square(x0 + dx, y0 - 300, 60) }))),
            inMeters('pins', [[10, 10], [50, 50], [330, 30]].map(([dx, dy]) => ({ properties: {}, geometry: point(x0 + dx, y0 - 300 + dy) }))),
        ],
        compute: [
            {
                // Each spot sums the widths of the parts' outlines, read as the GeoJSON source gave them: autk-db keeps
                // each part in its building model, where geometry.coordinates.0 finds no outline, so its copy gives 0.
                dataRef: 'spots',
                attributes: { w: 'w' },
                uniformMatrices: { o: { fromFeature: { layer: 'parts', path: 'geometry.coordinates.0', iterate: 'batched' }, cols: 2 } },
                outputColumnName: 'width',
                outputTableName: 'widths',
                layerType: 'points',
                writeBack: true,
                wgslFunction: [
                    'var total = 0.0;',
                    'for (var i = 0u; i < u32(num_features); i++) { total += o[i * 8u + 2u] - o[i * 8u]; }',
                    'return total * w;',
                ],
            },
            { type: 'clusters', dataRef: 'squares', outputColumnName: 'cluster', writeBack: true },
        ],
    } as unknown as UrbanSpec;
    const { afterPasses, atEnd } = await page.evaluate(({ s, names }) => window.runOnHostDb(s, names), { s: spec, names: ['widths', 'squares', 'totals'] });

    // Once the passes have run: each spot read the three parts, 3 x 20 m, into a new table of points, and the squares
    // hold their clusters, in place, with no layer type of their own.
    expect(afterPasses.widths?.layerType).toBe('points');
    const widths = (afterPasses.widths?.rows ?? []).map((row) => (row?.compute as { width?: number } | undefined)?.width);
    expect(widths).toHaveLength(4);
    for (const width of widths) expect(width as number).toBeCloseTo(60, 3);
    expect(afterPasses.squares?.layerType).toBeNull();
    expect(Object.fromEntries((afterPasses.squares?.rows ?? []).map((row) => [row?.name, (row?.compute as { cluster?: number } | undefined)?.cluster])))
        .toEqual({ a: 0, b: 0, c: 1 });
    expect(afterPasses.totals).toBeNull();

    // The host's database holds both results, written back: every spot with its width, and each square with its cluster.
    const [kept] = await page.evaluate(() => window.hostRows(
        "SELECT CAST(count(*) AS INTEGER) AS n, min(CAST(properties->'compute'->>'width' AS DOUBLE)) AS low, max(CAST(properties->'compute'->>'width' AS DOUBLE)) AS high FROM widths"));
    expect(kept.n).toBe(4);
    expect(kept.low as number).toBeCloseTo(60, 3);
    expect(kept.high as number).toBeCloseTo(60, 3);

    // The sources after compute ran on it, over what the passes kept there: the widths summed, and the pins of each
    // square beside its cluster.
    const [totals] = await page.evaluate(() => window.hostRows('SELECT spots, width FROM totals'));
    expect(totals.spots).toBe(4);
    expect(totals.width as number).toBeCloseTo(240, 2);
    const squaresQuery = "SELECT properties->>'name' AS name, CAST(properties->'compute'->>'cluster' AS INTEGER) AS cluster, "
        + "CAST(properties->'sjoin'->'count'->>'pins' AS INTEGER) AS pins FROM squares ORDER BY name";
    const squares = [{ name: 'a', cluster: 0, pins: 2 }, { name: 'b', cluster: 0, pins: 0 }, { name: 'c', cluster: 1, pins: 1 }];
    expect(await page.evaluate((query) => window.hostRows(query), squaresQuery)).toEqual(squares);

    // The join wrote the squares, so the steps hold no result of a pass for them now: autk-db's table, with the clusters
    // and the counts, is the one maps and plots read. The widths, which the sql source only read, stay as the pass left them.
    expect(atEnd.squares).toBeNull();
    expect(atEnd.widths).toEqual(afterPasses.widths);
    expect(atEnd.totals).toBeNull();

    // AutkGrammar's own run of the spec leaves the same tables in its database, and the same widths in grammar.data.
    await runSpec(page, spec);
    expect(await page.evaluate((query) => window.dbRows(query), squaresQuery)).toEqual(squares);
    const [ran] = await page.evaluate(() => window.dbRows('SELECT spots, width FROM totals'));
    expect(ran.spots).toBe(4);
    expect(ran.width as number).toBeCloseTo(totals.width as number, 3);
    const ranWidths = await page.evaluate(async () => (await window.grammar.data.widths).features.map((feature) => feature.properties?.compute?.width));
    expect(ranWidths).toHaveLength(4);
    ranWidths.forEach((width, i) => expect(width as number).toBeCloseTo(widths[i] as number, 3));
});

// A host made AutkGrammar with adapters of its own around the grammar's (wrapDataAdapter and wrapComputeAdapter), which
// every run calls instead. window.runWrapped makes them: they record what goes through them and hand it on, the data
// adapter handing the grammar's a database the page made.

test("sends a run's workspaces, every source and every pass through a host's own adapters around the grammar's, on the host's database", async ({ page }) => {
    const spec: UrbanSpec = {
        // autk-db's own CRS and grid for the default workspace, so the run sets up its workspaces and draws as without them.
        workspaces: [{ coordinateFormat: 'EPSG:3395', precisionGrid: 0.01 }],
        data: [
            // Listed first, the sources after compute run once both passes have, in this order.
            { type: 'join', dataRef: 'squares', joinDataRef: 'pins', groupBy: [{ column: '*', aggregateFn: 'count' }], after: 'compute' },
            area, fourSquares, pins,
            {
                type: 'sql', outputTableName: 'sizes', after: 'compute',
                query: "SELECT CAST(properties->'compute'->>'block' AS INTEGER) AS block, CAST(count(*) AS INTEGER) AS squares FROM blocks GROUP BY block ORDER BY block",
            },
        ],
        compute: [
            { type: 'clusters', dataRef: 'squares', outputColumnName: 'cluster', writeBack: true },
            { type: 'clusters', dataRef: 'squares', outputColumnName: 'block', outputTableName: 'blocks', writeBack: true },
        ],
        map: { layerRefs: [{ dataRef: 'area' }, { dataRef: 'squares', getFnv: 'sjoin.count.pins' }] },
    };
    const seen = await page.evaluate((s) => window.runWrapped(s), spec);

    // Each wrap function was called once, as the grammar was made.
    expect([...seen.wrapped].sort()).toEqual(['compute', 'data']);
    // The workspaces, every source and every pass went through the host's adapters once each, in the order the engine
    // runs them: the sources before compute in the order of data, the passes, then the sources after compute.
    expect(seen.steps).toEqual([
        'workspaces',
        'source geojson area', 'source geojson squares', 'source geojson pins',
        'pass clusters squares', 'pass clusters blocks',
        'source join squares', 'source sql sizes',
    ]);
    // The run went on with the database the host's data adapter handed the grammar's, which holds the run's tables.
    expect(seen.onHostDb).toBe(true);
    expect(await page.evaluate(() => window.hostRows('SELECT block, squares FROM sizes ORDER BY block')))
        .toEqual([{ block: 0, squares: 2 }, { block: 1, squares: 2 }]);
    // The grammar's own adapters ran inside the host's: the map draws each square with the pass's cluster and the join's
    // count of pins, as a run without the host's adapters draws them.
    const drawn = await page.evaluate(() => window.drawnRows('map0', 'squares').map((row) =>
        `${row?.name} ${(row?.compute as { cluster?: number } | undefined)?.cluster} ${(row?.sjoin as { count?: { pins?: number } } | undefined)?.count?.pins}`));
    expect(drawn.sort()).toEqual(['a 0 2', 'b 0 0', 'c 1 1', 'd 1 0']);
    await runSpec(page, spec);
    const unwrapped = await page.evaluate(() => window.drawnRows('map0', 'squares').map((row) =>
        `${row?.name} ${(row?.compute as { cluster?: number } | undefined)?.cluster} ${(row?.sjoin as { count?: { pins?: number } } | undefined)?.count?.pins}`));
    expect(unwrapped.sort()).toEqual(drawn);
});

// What a run handed each view, which a host reads with the collection of each layer mapLayers gives and with
// plotCollection.

test("gives the collection a run handed each view: the one autk-map was handed for each layer, and every row for a plot", async ({ page }) => {
    // Five sites, c without a geometry, and a heatmap of the nine spots, drawn on one map; a plot of the sites.
    const sites = ['a', 'b', 'c', 'd', 'e'].map((name, i) => ({
        type: 'Feature' as const,
        properties: { name, v: i * 10, w: 40 - i * 10 },
        geometry: name === 'c' ? null : { type: 'Point' as const, coordinates: [-73.985 + i * 0.002, 40.75 + i * 0.001] },
    }));
    await runSpec(page, {
        data: [
            { type: 'geojson', outputTableName: 'sites', geojsonObject: { type: 'FeatureCollection', features: sites } },
            spots,
            { type: 'heatmap', outputTableName: 'heat', joinDataRef: 'spots', near: { distance: 1000 }, grid: { rows: 2, columns: 2 } },
        ],
        map: { id: 'm', layerRefs: [{ dataRef: 'heat' }, { dataRef: 'sites', title: 'Sites' }] },
        plot: { id: 'p', dataRef: 'sites', mark: 'scatter', axis: ['v', 'w'] },
    } as unknown as UrbanSpec);

    // Each layer's collection is the very one autk-map was handed for it: the raster's, of one feature, and the sites'.
    expect(await page.evaluate(() => [window.handedToLayer('map0', 'heat', 'heat'), window.handedToLayer('map0', 'sites', 'Sites')]))
        .toEqual([true, true]);
    expect(await page.evaluate(() => window.grammar.mapLayer('heat', 'm')?.collection.features.length)).toBe(1);
    // The layer of the sites draws those of its features that have a shape: c has none.
    expect((await page.evaluate(() => window.drawnRows('map0', 'Sites'))).map((row) => row?.name).sort()).toEqual(['a', 'b', 'd', 'e']);
    // The plot's collection is every row of the sites, c among them, in their order, which its marks draw.
    const plotted = await page.evaluate(() => window.grammar.plotCollection('p')?.features.map((feature) => [feature.properties?.name, feature.geometry === null]));
    expect(plotted).toEqual([['a', false], ['b', false], ['c', true], ['d', false], ['e', false]]);
    expect((await page.evaluate(() => window.plotMarks())).map((mark) => mark.datum?.name).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);

    // destroy(), which each run calls first, lets the last run's views go.
    await page.evaluate(() => window.grammar.destroy());
    expect(await page.evaluate(() => [window.grammar.mapLayers('sites').length, window.grammar.plotCollection('p') ?? null])).toEqual([0, null]);
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

test('refuses a compute pass of an unknown type, which ran as a GPGPU pass', async ({ page }) => {
    // A misspelt type ran the pass as a GPGPU pass, which failed on the shader fields it lacks, with no word of the type.
    await expect(runSpec(page, {
        data: [area, zones],
        compute: [{ type: 'window', dataRef: 'zones', floors: 1, outputTableName: 'w' } as unknown as ComputeSpec],
    })).rejects.toThrow('Unknown compute pass type "window".');
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

test('refuses a heatmap groupBy entry with no aggregateFn, naming the heatmap and its column, which autk-db 4.1.1 drew as 0', async ({ page }) => {
    // A cell holds one value, and nothing combines the rows near it without an aggregate. The schema takes such an
    // entry, as a join's groupBy does, and the adapter passed it on to autk-db, which lists the column's values near
    // each cell for it: on 4.1.1 its band read 0 in every cell, with no error.
    const heatmap = (groupBy: HeatmapSourceSpec['groupBy']): DataSourceSpec => ({
        type: 'heatmap', outputTableName: 'heat', joinDataRef: 'spots', near: { distance: 10000 }, grid: { rows: 2, columns: 2 }, groupBy,
    });
    const refusal = 'Heatmap "heat": the groupBy entry for column "id" has no aggregateFn to combine the rows near a cell, and a cell holds one value; use sum, avg, count, min, max or weighted.';
    await expect(runSpec(page, { data: [area, spots, heatmap([{ column: 'id' }])] })).rejects.toThrow(refusal);
    // Behind an entry that has one, it is still the entry named. A JSON spec's null is no aggregateFn, as autk-db reads it.
    await expect(runSpec(page, { data: [area, spots, heatmap([{ column: '*', aggregateFn: 'count' }, { column: 'id' }])] })).rejects.toThrow(refusal);
    await expect(runSpec(page, { data: [area, spots, heatmap([{ column: 'id', aggregateFn: null as never }])] })).rejects.toThrow(refusal);
    // With an aggregateFn, the same entry builds the heatmap: each of the four cells is within 10 km of all nine spots.
    await runSpec(page, { data: [area, spots, heatmap([{ column: 'id', aggregateFn: 'count' }])], map: { layerRefs: [{ dataRef: 'area' }, { dataRef: 'heat' }] } });
    expect(await page.evaluate(() => window.handedBand('map0', 'heat', 'band_1'))).toEqual([9, 9, 9, 9]);
});

test('counts the rows near each cell of a heatmap without groupBy, as with a count, which autk-db 4.1.1 drew as 0', async ({ page }) => {
    // Each of the four cells is within 10 km of all nine spots.
    const heatmap = (fields: object): DataSourceSpec => ({
        type: 'heatmap', outputTableName: 'heat', joinDataRef: 'spots', near: { distance: 10000 }, grid: { rows: 2, columns: 2 }, ...fields,
    }) as DataSourceSpec;
    const cells = async (fields: object) => {
        await runSpec(page, { data: [area, spots, heatmap(fields)], map: { layerRefs: [{ dataRef: 'area' }, { dataRef: 'heat' }] } });
        return page.evaluate(() => window.handedBand('map0', 'heat', 'band_1'));
    };
    expect(await cells({ groupBy: [{ column: '*', aggregateFn: 'count' }] })).toEqual([9, 9, 9, 9]);
    expect(await cells({})).toEqual([9, 9, 9, 9]);
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

test('saves a sql source whose query returns its geometry as geometry, and tells one that DuckDB finds no geometry column for to name a geometry it returns so', async ({ page }) => {
    // autk-db puts the geometry of a table a query saves on the workspace's grid, read from a column named geometry, with
    // a layerType or without one. DuckDB's error for a geometry under another name is the one for a query that reads a
    // geometry column its table lacks, so the advice holds for both.
    const centers = (name: string): DataSourceSpec => ({
        type: 'sql', outputTableName: 'centers', query: `SELECT CAST(properties->>'id' AS INTEGER) AS id, ST_Centroid(geometry) AS ${name} FROM zones`,
    });
    await runSpec(page, { data: [area, zones, centers('geometry')] });
    expect(await page.evaluate(() => window.dbRows('SELECT id FROM centers ORDER BY id'))).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }]);
    const counts: DataSourceSpec = { type: 'csv', outputTableName: 'counts', csvObject: [['zone', 'count'], [1, 10]] };
    /** The run's message when it was refused. */
    const refusal = (spec: UrbanSpec) => runSpec(page, spec).then(() => 'ran', (error: Error) => error.message);
    const advice = (table: string) => expect.stringContaining(
        `SQL source "${table}": if the query returns a geometry, name it geometry, for example ST_Centroid(geometry) AS geometry. autk-db: Binder Error: Referenced column "geometry" not found`,
    );
    expect([
        await refusal({ data: [area, zones, centers('center')] }),
        // A table of plain columns has no geometry to read.
        await refusal({ data: [counts, { type: 'sql', outputTableName: 'placed', query: 'SELECT zone, geometry FROM counts' }] }),
    ]).toEqual([advice('centers'), advice('placed')]);
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

test("updates a table without a geometry by the names of its columns, whatever the order of a given row's keys", async ({ page }) => {
    // autk-db stages the given rows with their columns in the order of their keys, then inserts them by position: on 4.1.1
    // { count: 25, zone: 2 } wrote 25 in zone and 2 in count, and { total: 9, month: 'Feb' } was refused for its total.
    const zoneCounts: DataSourceSpec = { type: 'csv', outputTableName: 'zones', csvObject: [['zone', 'count'], [1, 10], [2, 20]] };
    const sales: DataSourceSpec = { type: 'csv', outputTableName: 'sales', csvObject: [['month', 'total'], ['Jan', 3], ['Feb', 5]] };
    /** The table's rows in autk-db once the update ran, or the run's message when it was refused. */
    const updated = (source: DataSourceSpec, dataRef: string, idColumn: string, jsonObject: Array<Record<string, unknown>>) =>
        runSpec(page, { data: [source, { type: 'update', dataRef, strategy: 'update', idColumn, jsonObject }] })
            .then(() => page.evaluate((table) => window.dbRows(`SELECT * FROM ${table} ORDER BY 1`), dataRef), (error: Error) => error.message);
    expect([
        await updated(zoneCounts, 'zones', 'zone', [{ count: 25, zone: 2 }]),
        await updated(sales, 'sales', 'month', [{ total: 9, month: 'Feb' }]),
        // A column a row leaves out is null in it, and a key the table lacks is refused.
        await updated(sales, 'sales', 'month', [{ month: 'Feb' }]),
        await updated(sales, 'sales', 'month', [{ month: 'Feb', total: 9, note: 'late' }]),
    ]).toEqual([
        [{ zone: 1, count: 10 }, { zone: 2, count: 25 }],
        [{ month: 'Feb', total: 9 }, { month: 'Jan', total: 3 }],
        [{ month: 'Feb', total: null }, { month: 'Jan', total: 3 }],
        expect.stringContaining('Update of "sales": jsonObject[0] has "note", which is not a column of the table: "month", "total".'),
    ]);
});

test('autk-db 4.1.1, handed the jsonObject rows of an update as 5.6.0 handed them, writes a key a row leaves out as null and matches names without regard to case', async ({ page }) => {
    // This test encodes autk-db 4.1.1, run as 5.6.0's data adapter ran it: an update of a table without a geometry handed
    // its jsonObject to updateTable unchanged (window.dbUpdate). autk-db stages the rows with DuckDB's read_json_auto,
    // deletes the table's rows whose idColumn value a staged row has, then inserts every staged row by position. The
    // grammar writes such rows as autk-db wrote these, each with its keys in the table's column order (the next test).
    // Both E2E legs run autk-db 4.1.1, the newest on npm, so a later autk-db that writes them otherwise fails here.
    const zoneCounts = (zone: string, count: string): DataSourceSpec => ({ type: 'csv', outputTableName: 'zones', csvObject: [[zone, count], [1, 10], [2, 20]] });
    const sales: DataSourceSpec = { type: 'csv', outputTableName: 'sales', csvObject: [['month', 'total'], ['Jan', 3], ['Feb', 5]] };
    /** The table's rows once autk-db's update ran on the rows as given, or autk-db's refusal. */
    const written = async (source: DataSourceSpec, table: string, idColumn: string, data: Array<Record<string, unknown>>) => {
        await runSpec(page, { data: [source] });
        return page.evaluate(async ([table, idColumn, data]) => {
            try {
                await window.dbUpdate({ tableName: table, data, strategy: 'update', idColumn });
            } catch (error) {
                return `refused: ${error instanceof Error ? error.message : String(error)}`;
            }
            return window.dbRows(`SELECT * FROM ${table} ORDER BY 1`);
        }, [table, idColumn, data] as const);
    };
    const refused = expect.stringMatching(/^refused: /);
    expect([
        // A key one row gives and another leaves out: null in the row that leaves it out.
        await written(zoneCounts('zone', 'count'), 'zones', 'zone', [{ zone: 2, count: 25 }, { zone: 3 }]),
        // Keys in another case than the table's columns.
        await written(zoneCounts('Zone', 'Count'), 'zones', 'zone', [{ zone: 2, count: 25 }]),
        // A null in a column no row gives a value, as the grammar hands autk-db a key a row leaves out.
        await written(sales, 'sales', 'month', [{ month: 'Feb', total: null }]),
        // A column no row gives: the staged rows have one column fewer than the table.
        await written(sales, 'sales', 'month', [{ month: 'Feb' }]),
        // A key the table lacks, in place of one of its columns: its value goes into that column.
        await written(zoneCounts('zone', 'count'), 'zones', 'zone', [{ zone: 2, note: 5 }]),
        // A key the table lacks, beside all of its columns: the staged rows have one column more than the table.
        await written(zoneCounts('zone', 'count'), 'zones', 'zone', [{ zone: 2, count: 25, note: 'late' }]),
        // Two keys that name one column, in two cases.
        await written(zoneCounts('zone', 'count'), 'zones', 'zone', [{ zone: 2, Zone: 3, count: 25 }]),
    ]).toEqual([
        [{ zone: 1, count: 10 }, { zone: 2, count: 25 }, { zone: 3, count: null }],
        [{ Zone: 1, Count: 10 }, { Zone: 2, Count: 25 }],
        [{ month: 'Feb', total: null }, { month: 'Jan', total: 3 }],
        refused,
        [{ zone: 1, count: 10 }, { zone: 2, count: 5 }],
        refused,
        refused,
    ]);
});

test('updates a table without a geometry as autk-db 4.1.1 wrote the rows 5.6.0 handed it, each value in the column its key names, and refuses a key the table lacks', async ({ page }) => {
    // The rows of the test before this one, through the grammar: a column a row leaves out is null in it, and a key names
    // its column without regard to case. A key the table lacks, which 4.1.1 wrote into another column or refused, is
    // refused, naming it.
    const zoneCounts = (zone: string, count: string): DataSourceSpec => ({ type: 'csv', outputTableName: 'zones', csvObject: [[zone, count], [1, 10], [2, 20]] });
    const lower = zoneCounts('zone', 'count');
    const upper = zoneCounts('Zone', 'Count');
    /** The table's rows in autk-db once the update ran, or the run's message when it was refused. */
    const updated = (source: DataSourceSpec, jsonObject: Array<Record<string, unknown>>) =>
        runSpec(page, { data: [source, { type: 'update', dataRef: 'zones', strategy: 'update', idColumn: 'zone', jsonObject }] })
            .then(() => page.evaluate(() => window.dbRows('SELECT * FROM zones ORDER BY 1')), (error: Error) => error.message);
    const notAColumn = expect.stringContaining('Update of "zones": jsonObject[0] has "note", which is not a column of the table: "zone", "count".');
    expect([
        await updated(lower, [{ zone: 2, count: 25 }, { zone: 3 }]),
        await updated(lower, [{ count: 25, zone: 2 }, { zone: 3 }]),
        await updated(upper, [{ zone: 2, count: 25 }]),
        await updated(upper, [{ count: 25, zone: 2 }]),
        await updated(lower, [{ zone: 2, note: 5 }]),
        await updated(lower, [{ zone: 2, count: 25, note: 'late' }]),
        await updated(lower, [{ zone: 2, Zone: 3, count: 25 }]),
    ]).toEqual([
        [{ zone: 1, count: 10 }, { zone: 2, count: 25 }, { zone: 3, count: null }],
        [{ zone: 1, count: 10 }, { zone: 2, count: 25 }, { zone: 3, count: null }],
        [{ Zone: 1, Count: 10 }, { Zone: 2, Count: 25 }],
        [{ Zone: 1, Count: 10 }, { Zone: 2, Count: 25 }],
        notAColumn,
        notAColumn,
        expect.stringContaining('Update of "zones": jsonObject[0] has "zone" and "Zone", which name one column of the table, "zone".'),
    ]);
});

test('refuses the update strategy on a table whose column named as a whole number comes after another, and leaves its rows as they were', async ({ page }) => {
    // The rows of an update reach autk-db as JSON objects, which put a key named as a whole number, such as "2020", before
    // the others, and autk-db 4.1.1 inserts them by position: zone 2's row below wrote 25 in zone and 2 in "2020". The run
    // refuses such an update before autk-db runs. A refused run leaves the grammar no database to read, so the run goes
    // through runWrapped, whose database hostRows reads back.
    const zones: DataSourceSpec = { type: 'csv', outputTableName: 'zones', csvObject: [['zone', '2020'], [1, 10], [2, 20]] };
    const spec = { data: [zones, { type: 'update', dataRef: 'zones', strategy: 'update', idColumn: 'zone', jsonObject: [{ zone: 2, '2020': 25 }] }] } as UrbanSpec;
    const outcome = await page.evaluate((spec) => window.runWrapped(spec), spec).then(() => 'ran', (error: Error) => error.message);
    expect(await page.evaluate(() => window.hostRows('SELECT * FROM zones ORDER BY 1'))).toEqual([{ zone: 1, '2020': 10 }, { zone: 2, '2020': 20 }]);
    expect(outcome).toContain(`Update of "zones": the update strategy cannot change a table whose column "2020", named as a whole number, comes after "zone". Use strategy 'replace' with every row of the table, or rename the column.`);
});

test('replaces the rows of a layer of plain columns, and refuses the update strategy on it, which autk-db 4.1.1 cannot run there', async ({ page }) => {
    // A CSV table of points keeps each value in a column of its own beside its geometry: it has no properties column,
    // which autk-db's update of a layer sets, and no feature id.
    const noise: DataSourceSpec = {
        type: 'csv', outputTableName: 'noise', geometryColumns: true,
        csvObject: [['key', 'level', 'Latitude', 'Longitude'], [1, 50, 40.75, -73.98], [2, 70, 40.76, -73.97]],
    };
    await runSpec(page, { data: [noise] });
    const exported = await page.evaluate(async () => (await window.grammar.data.noise).features);
    expect(exported).toHaveLength(2);
    const edited = {
        type: 'FeatureCollection',
        features: exported.map((feature) => ({ ...feature, properties: { ...feature.properties, level: feature.properties?.key === 2 ? 75 : feature.properties?.level } })),
    };
    // replace swaps its rows for its own export, edited.
    await runSpec(page, { data: [noise, { type: 'update', dataRef: 'noise', strategy: 'replace', geojsonObject: edited } as DataSourceSpec] });
    expect(await page.evaluate(async () => (await window.grammar.data.noise).features.map((feature) => Number(feature.properties?.level)).sort((a, b) => a - b)))
        .toEqual([50, 75]);

    // The update strategy is refused, by a property, by a column or with rows without a geometry, before autk-db runs; so
    // is an update of a sql source's table of plain columns drawn as a layer.
    const outcome = (spec: UrbanSpec) => runSpec(page, spec).then(() => 'ran', (error: Error) => error.message);
    const update = (dataRef: string, fields: object) => ({ type: 'update', dataRef, strategy: 'update', ...fields }) as DataSourceSpec;
    const zoneValues: DataSourceSpec = {
        type: 'sql', outputTableName: 'zone_values', layerType: 'polygons',
        query: "SELECT CAST(properties->>'id' AS INTEGER) AS zone, CAST(properties->>'v' AS INTEGER) AS v, geometry FROM zones",
    };
    const zoneTwo = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null, properties: { zone: 2, v: 99 } }] };
    const refused = (table: string) => expect.stringContaining(`Update of "${table}": on a layer, the update strategy sets the properties column of each row it matches, and this layer has none`);
    expect([
        await outcome({ data: [noise, update('noise', { idColumn: 'properties.key', geojsonObject: edited })] }),
        await outcome({ data: [noise, update('noise', { idColumn: 'key', geojsonObject: edited })] }),
        await outcome({ data: [noise, update('noise', { idColumn: 'key', jsonObject: [{ key: 2, level: 75 }] })] }),
        await outcome({ data: [area, zones, zoneValues, update('zone_values', { idColumn: 'properties.zone', geojsonObject: zoneTwo })] }),
    ]).toEqual([refused('noise'), refused('noise'), refused('noise'), refused('zone_values')]);
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

test("looks at camera.center, put in the CRS of the map's workspace, and turns the view around it", async ({ page }) => {
    // A point of zones about 220 m west and 510 m south of the middle of area, the map's origin, which the view without
    // a center looks at.
    const center: [number, number] = [-73.982, 40.7515];
    const spec = (camera: CameraSpec, workspaces?: UrbanSpec['workspaces']): UrbanSpec => ({
        ...(workspaces && { workspaces }), data: [area, zones], map: { camera, layerRefs: [{ dataRef: 'zones' }] },
    });
    const view = () => page.evaluate(() => window.cameraView('map0'));
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const unit = (a: number[]) => a.map((value) => value / Math.sqrt(dot(a, a)));
    // The point looked at, back in the workspace's CRS: the world is relative to the map's origin.
    const lookedAt = ({ lookAt, origin }: { lookAt: number[]; origin: number[] }) => [lookAt[0] + origin[0], lookAt[1] + origin[1]];

    await runSpec(page, { data: [area, zones], map: { layerRefs: [{ dataRef: 'zones' }] } });
    const fitted = await view();

    // A center alone: the eye goes straight above it, as high as the view without a center has it.
    await runSpec(page, spec({ center }));
    const above = await view();
    const [x, y] = worldMercator(...center);
    const [atX, atY] = lookedAt(above);
    expect(Math.abs(atX - x), 'x of the point looked at, in World Mercator meters').toBeLessThan(0.01);
    expect(Math.abs(atY - y), 'y of the point looked at, in World Mercator meters').toBeLessThan(0.01);
    expect(above.eye[0]).toBeCloseTo(above.lookAt[0], 2);
    expect(above.eye[1]).toBeCloseTo(above.lookAt[1], 2);
    expect(above.eye[2]).toBeCloseTo(fitted.eye[2], 2);

    // With zoom, pitch and bearing, the eye turns around the center, with its up across the line of sight.
    await runSpec(page, spec({ center, zoom: 13, pitch: 55, bearing: 30 }));
    const turned = await view();
    const [turnedX, turnedY] = lookedAt(turned);
    expect(Math.abs(turnedX - x)).toBeLessThan(0.01);
    expect(Math.abs(turnedY - y)).toBeLessThan(0.01);
    const distance = 10000 / 2 ** 3;
    const [tilt, heading] = [55, 30].map((degrees) => (degrees * Math.PI) / 180);
    expect(turned.eye[0] - turned.lookAt[0]).toBeCloseTo(-distance * Math.sin(tilt) * Math.sin(heading), 2);
    expect(turned.eye[1] - turned.lookAt[1]).toBeCloseTo(-distance * Math.sin(tilt) * Math.cos(heading), 2);
    expect(turned.eye[2] - turned.lookAt[2]).toBeCloseTo(distance * Math.cos(tilt), 2);
    const sight = unit(turned.lookAt.map((value, i) => value - turned.eye[i]));
    expect(Math.abs(dot(unit(turned.up), sight)), 'up across the line of sight').toBeLessThan(1e-5);
    expect(turned.up[2], 'up toward the sky').toBeGreaterThan(0);

    // A host's later turn of the map, by the same camera, looks at the same center; one the run never put on the map
    // is refused.
    await page.evaluate((camera) => window.turnCamera('map0', camera), { center, pitch: 40 } as CameraSpec);
    const again = lookedAt(await view());
    expect(Math.abs(again[0] - x)).toBeLessThan(0.01);
    expect(Math.abs(again[1] - y)).toBeLessThan(0.01);
    await expect(page.evaluate(() => window.turnCamera('map0', { center: [-73.97, 40.76] })))
        .rejects.toThrow('camera.center [-73.97, 40.76] has no point on this map yet');

    // In a workspace in Web Mercator, the center is a point of Web Mercator, about 33 km from World Mercator's here.
    await runSpec(page, spec({ center }, [{ coordinateFormat: 'EPSG:3857', precisionGrid: 0.01 }]));
    const [webX, webY] = lookedAt(await view());
    const [wx, wy] = webMercator(...center);
    expect(Math.abs(webX - wx), 'x of the point looked at, in Web Mercator meters').toBeLessThan(0.01);
    expect(Math.abs(webY - wy), 'y of the point looked at, in Web Mercator meters').toBeLessThan(0.01);

    // A center that is not [longitude, latitude] is refused before anything draws, and leaves no map on the page.
    await expect(runSpec(page, spec({ center: [-73.98, 40.75, 0] as unknown as [number, number] })))
        .rejects.toThrow('Map 0: camera.center must be [longitude, latitude] in degrees');
    expect(await page.evaluate(() => window.grammar.maps.length)).toBe(0);
});

/**
 * A view as a camera tour leaves it, in a map's world: tilted `tilt` degrees from straight down, facing `heading`
 * clockwise from north and banked `bank` degrees, `distance` from the point `[x, y]` of the ground it looks at.
 */
type TourView = { tilt: number; heading: number; distance: number; x: number; y: number; bank?: number };

/**
 * Checks a map's camera, as window.cameraView reads it, against `expected`: its eye, the point of the ground its line of
 * sight meets, and its up direction, which a bank turns around the line of sight, clockwise as the viewer sees it.
 */
function expectTourView(name: string, view: CameraView, expected: TourView): void {
    const radians = (degrees: number) => (degrees * Math.PI) / 180;
    const [t, h, k] = [radians(expected.tilt), radians(expected.heading), radians(expected.bank ?? 0)];
    const eye = [
        expected.x - expected.distance * Math.sin(t) * Math.sin(h),
        expected.y - expected.distance * Math.sin(t) * Math.cos(h),
        expected.distance * Math.cos(t),
    ];
    const sight = [Math.sin(t) * Math.sin(h), Math.sin(t) * Math.cos(h), -Math.cos(t)];
    const level = [Math.cos(t) * Math.sin(h), Math.cos(t) * Math.cos(h), Math.sin(t)];
    const side = [sight[1] * level[2] - sight[2] * level[1], sight[2] * level[0] - sight[0] * level[2], sight[0] * level[1] - sight[1] * level[0]];
    const up = level.map((value, i) => value * Math.cos(k) + side[i] * Math.sin(k));
    const reach = -view.eye[2] / view.sight[2];
    const ground = [view.eye[0] + view.sight[0] * reach, view.eye[1] + view.sight[1] * reach];
    const length = Math.hypot(view.up[0], view.up[1], view.up[2]);
    eye.forEach((value, i) => expect(Math.abs(view.eye[i] - value), `${name}: eye ${i}`).toBeLessThan(0.05));
    [expected.x, expected.y].forEach((value, i) => expect(Math.abs(ground[i] - value), `${name}: ground point ${i}`).toBeLessThan(0.05));
    up.forEach((value, i) => expect(Math.abs(view.up[i] / length - value), `${name}: up ${i}`).toBeLessThan(1e-4));
}

test("plays camera.motion once the map is drawn, from the view its camera sets, and ends where the steps add up to", async ({ page }) => {
    const camera: CameraSpec = { zoom: 12, pitch: 30 };
    const motion: CameraMotionStep[] = [
        { type: 'zoom', amount: 1, seconds: 0.25 },
        { type: 'pitch', amount: 20, seconds: 0.25, pan: 200 },
        { type: 'bearing', amount: 90, seconds: 0.25 },
        { type: 'roll', amount: 30, seconds: 0.25 },
    ];
    const spec = (withMotion: boolean): UrbanSpec => ({
        data: [area, zones], map: { camera: { ...camera, ...(withMotion && { motion }) }, layerRefs: [{ dataRef: 'zones' }] },
    });
    // The view the camera sets, which the tour starts from: 2500 units from the point the map looks at, tilted 30 degrees.
    await runSpec(page, spec(false));
    const start = await page.evaluate(() => window.cameraView('map0'));
    expectTourView('the view before the tour', start, { tilt: 30, heading: 0, distance: 2500, x: start.lookAt[0], y: start.lookAt[1] });
    expect(await page.evaluate(() => window.grammar.tours.map((tour) => tour === undefined))).toEqual([true]);

    // The run does not wait for the tour; its done settles once the last step ends. One level in halves the distance,
    // the pitch step tilts 20 degrees further and moves the point it turns around 200 units north, the top of the view,
    // the bearing turns the heading clockwise to east, and the roll banks the view 30 degrees.
    await runSpec(page, spec(true));
    expect(await page.evaluate(async () => {
        const tours = window.grammar.tours;
        await tours[0]?.done;
        return tours.map((tour) => tour === undefined);
    })).toEqual([false]);
    const end = await page.evaluate(() => window.cameraView('map0'));
    expectTourView('the end of the tour', end, { tilt: 50, heading: 90, distance: 1250, x: start.lookAt[0], y: start.lookAt[1] + 200, bank: 30 });
    await expectDrawn(page, 'map0');
});

test('turns the view of a camera tour at the times a clock the test controls says', async ({ page }) => {
    // The clock runs the page's time from here: CameraMotion reads performance.now() and turns the camera in animation
    // frames, which this clock draws every 16 ms of its time, each called with that time.
    await page.clock.install();
    await runSpec(page, { data: [area, zones], map: { camera: { zoom: 12, pitch: 30 }, layerRefs: [{ dataRef: 'zones' }] } });
    const start = await page.evaluate(() => window.cameraView('map0'));
    const [x, y] = start.lookAt;

    // Stop the clock, on a frame's time, then play a tour from the view the camera set, with the grammar's player.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    const ticks = await page.evaluate(() => performance.now());
    await page.clock.runFor((16 - (ticks % 16)) % 16);
    await page.evaluate((motion) => window.playTour('map0', motion), [
        { type: 'zoom', amount: 1, seconds: 0.512 },
        { type: 'bearing', amount: -90, seconds: 0.512 },
    ] as CameraMotionStep[]);

    // Each step eases in and out over its 512 ms: an eighth of the way at a quarter of it, half at half.
    const after = async (ms: number, name: string, expected: TourView) => {
        await page.clock.runFor(ms);
        expectTourView(name, await page.evaluate(() => window.cameraView('map0')), expected);
    };
    await after(128, 'a quarter of the zoom', { tilt: 30, heading: 0, distance: 2500 * 2 ** -0.125, x, y });
    await after(128, 'half the zoom', { tilt: 30, heading: 0, distance: 2500 * 2 ** -0.5, x, y });
    await after(256, 'the end of the zoom', { tilt: 30, heading: 0, distance: 1250, x, y });
    await after(256, 'half the bearing, turning counterclockwise', { tilt: 30, heading: -45, distance: 1250, x, y });
    expect(await page.evaluate(() => window.tourEnded), 'the tour plays on until its last step ends').toBe(false);
    await after(256, 'the end of the bearing', { tilt: 30, heading: -90, distance: 1250, x, y });
    expect(await page.evaluate(() => window.tourEnded), 'done settles as the last step ends').toBe(true);
});

test('stops a camera tour when the grammar is destroyed, and refuses a tour that would tilt the view to 90 or take no time', async ({ page }) => {
    await runSpec(page, {
        data: [area, zones],
        map: { camera: { zoom: 12, pitch: 30, motion: [{ type: 'bearing', amount: 360, seconds: 60 }] }, layerRefs: [{ dataRef: 'zones' }] },
    });
    // destroy() stops the tour, whose done settles at once, and its steps no longer turn the map's camera.
    expect(await page.evaluate(async () => {
        const map = window.grammar.maps[0];
        const tour = window.grammar.tours[0]!;
        window.grammar.destroy();
        const settled = await Promise.race([
            tour.done.then(() => 'stopped'),
            new Promise((resolve) => setTimeout(() => resolve('still playing'), 5000)),
        ]);
        const eye = [...map.camera.getEye()];
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { settled, still: map.camera.getEye().every((value, i) => value === eye[i]) };
    })).toEqual({ settled: 'stopped', still: true });

    // The camera's pitch and the pitch steps add up to a tilt below 90, and a step takes some time; a tour that breaks
    // either is refused before the map is made.
    const run = (motion: CameraMotionStep[]) => runSpec(page, {
        data: [area, zones], map: { camera: { pitch: 30, motion }, layerRefs: [{ dataRef: 'zones' }] },
    });
    await expect(run([{ type: 'zoom', amount: 1, seconds: 1 }, { type: 'pitch', amount: 60, seconds: 1 }]))
        .rejects.toThrow('Map 0: camera.motion[1]: this pitch step would tilt the view 90 degrees from straight down.');
    expect(await page.evaluate(() => window.grammar.maps.length)).toBe(0);
    await expect(run([{ type: 'zoom', amount: 1, seconds: 0 }]))
        .rejects.toThrow('Map 0: camera.motion[0]: seconds must be a number greater than 0, not 0.');
});

test('stops a camera tour when the user drags, scrolls or presses a key on the map', async ({ page }) => {
    // Each frame of a tour sets the camera, so a tour that played on would undo every drag and zoom the user made.
    await runSpec(page, { data: [area, zones], map: { camera: { zoom: 12, pitch: 30 }, layerRefs: [{ dataRef: 'zones' }] } });
    for (const kind of ['drag', 'scroll', 'key']) {
        expect(await page.evaluate(async (input) => {
            window.playTour('map0', [{ type: 'bearing', amount: 360, seconds: 60 }]);
            const tour = window.tour!;
            const { camera, canvas } = window.grammar.maps[0];
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (input === 'drag') {
                canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
                document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
            } else if (input === 'scroll') {
                canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 1, clientX: 10, clientY: 10 }));
            } else {
                canvas.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'x' }));
            }
            const settled = await Promise.race([
                tour.done.then(() => 'stopped'),
                new Promise((resolve) => setTimeout(() => resolve('still playing'), 5000)),
            ]);
            const eye = [...camera.getEye()];
            await new Promise((resolve) => setTimeout(resolve, 500));
            return { settled, still: camera.getEye().every((value, i) => value === eye[i]) };
        }, kind), kind).toEqual({ settled: 'stopped', still: true });
    }
});

test('raises a map on the heights of the raster band its terrain names, and refuses a terrain that is not a raster band', async ({ page }) => {
    // The 24 yearly bands of the Niteroi temperature GeoTIFF, from 2001 to 2024, as heights: each band is another ground.
    // 2024's temperatures are draped over it in viridis, so the frame shows the ground the raster covers, cell by cell.
    const area = { type: 'Polygon' as const, coordinates: [[[-43.2, -22.95], [-43.0, -22.95], [-43.0, -22.8], [-43.2, -22.8], [-43.2, -22.95]]] };
    const withTerrain = (terrain?: TerrainSpec): UrbanSpec => ({
        data: [
            { type: 'geojson', outputTableName: 'area', geojsonObject: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: area, properties: {} }] } },
            { type: 'geotiff', outputTableName: 'lst', geotiffFileUrl: '/data/niteroi_lst_verao_2001_2024.tif' },
        ],
        map: {
            layerRefs: [
                { dataRef: 'area' },
                {
                    dataRef: 'lst', title: 'Temperature 2024', getFnv: 'band_24', colorMapInterpolator: scheme('interpolateViridis'),
                    transferFunction: { opacityMin: 1, opacityMax: 1 },
                },
            ],
            ...(terrain && { terrain }),
        },
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

test("gives in workspaceCrs the CRS of the last run's default workspace, the one the spec's workspaces set for it", async ({ page }) => {
    // workspaceCrs gave autk-db's default, EPSG:3395, whatever the spec's workspaces set.
    const webMercator = { coordinateFormat: 'EPSG:3857', precisionGrid: 1 };
    const runs: Array<UrbanSpec['workspaces']> = [
        undefined,
        [{ name: 'web', ...webMercator }], // another workspace only: the default one keeps autk-db's default
        [webMercator],
        [{ name: 'autk', ...webMercator }], // the default workspace, by the name autk-db gives it
    ];
    const seen: string[] = [];
    for (const workspaces of runs) {
        await runSpec(page, { ...(workspaces && { workspaces }), data: [area] });
        seen.push(await page.evaluate(() => window.grammar.workspaceCrs));
    }
    // The grammar run again, with a spec without workspaces.
    await page.evaluate((spec) => window.runAgain(spec), { data: [area] } as UrbanSpec);
    seen.push(await page.evaluate(() => window.grammar.workspaceCrs));
    expect(seen).toEqual(['EPSG:3395', 'EPSG:3395', 'EPSG:3857', 'EPSG:3857', 'EPSG:3395']);
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

test('tours camera-tour around the Stock Exchange: in, tilted while moving north, then turned to face east', async ({ page }) => {
    const { center, zoom } = ((await exampleSpec(page, 'camera-tour')).map as MapSpec).camera as Required<Pick<CameraSpec, 'center' | 'zoom'>>;
    await run(page, 'camera-tour');
    // The run does not wait for the tour: read the view once it has ended, never on the way.
    await page.evaluate(() => window.grammar.tours[0]?.done);
    const end = await page.evaluate(() => window.cameraView('map0'));
    // From 10000 / 2^(zoom - 10) away, straight above the Stock Exchange: 1.5 levels in, 55 degrees of tilt while the
    // point the view turns around moves 150 m north, the top of the view, then a quarter turn clockwise, to face east.
    const [x, y] = worldMercator(...center);
    expectTourView('the end of the tour', end, {
        tilt: 55, heading: 90, distance: (10000 / 2 ** (zoom - 10)) * 2 ** -1.5, x: x - end.origin[0], y: y - end.origin[1] + 150,
    });
    await expectDrawn(page, 'map0');
});

test('places the windows of building-windows along the facades around Wall Street, three rows a facade', async ({ page }) => {
    const { tables } = await run(page, 'building-windows');
    expect(tables.wall_st_windows.features).toBeGreaterThan(3 * tables.wall_st_buildings.features);
    const windows = await page.evaluate(async () => (await window.grammar.data.wall_st_windows).features.map((feature) => ({
        building: feature.properties?.sourceFeatureIndex as number,
        floor: feature.properties?.floorIndex as number,
        height: feature.properties?.buildingHeight as number,
    })));
    // Each window names a building of the table, and each building's facades hold as many windows on each of its three
    // rows.
    const rows = new Map<number, number[]>();
    for (const point of windows) {
        const counts = rows.get(point.building) ?? [0, 0, 0];
        counts[point.floor]++;
        rows.set(point.building, counts);
    }
    expect([...rows.keys()].every((building) => Number.isInteger(building) && building >= 0 && building < tables.wall_st_buildings.features)).toBe(true);
    expect([...rows.values()].filter(([first, second, third]) => !(first > 0 && second === first && third === first))).toEqual([]);
    expect(windows.every((point) => point.height > 0)).toBe(true);
    // The map draws them as points, in the color of their building's height.
    expect((await layerById(page))['Windows, by building height (m)']).toMatchObject({ type: 'points', isColorMap: true, interpolator: 'interpolateInferno' });
    await expectDrawn(page, 'map0');
});

test('colors the buildings of building-clusters by the block of touching buildings each is in', async ({ page }) => {
    const { tables } = await run(page, 'building-clusters');
    expect(tables.fidi_blocks.features).toBe(tables.fidi_buildings.features);
    const { blocks, sourceBlocks } = await page.evaluate(async () => ({
        blocks: (await window.grammar.data.fidi_blocks).features.map((feature) => feature.properties?.compute?.block as number),
        sourceBlocks: (await window.grammar.data.fidi_buildings).features.filter((feature) => feature.properties?.compute?.block !== undefined).length,
    }));
    // Each building is in a block, the blocks numbered from 0 with no gap, and buildings that share walls share one.
    const ids = [...new Set(blocks)].sort((a, b) => a - b);
    expect(blocks.every((block) => Number.isInteger(block)), 'every building is in a block').toBe(true);
    expect(ids).toEqual(ids.map((_, i) => i));
    expect(ids.length, 'blocks of more than one building').toBeLessThan(blocks.length);
    expect(sourceBlocks, 'buildings with a block column').toBe(0);
    // The new table is drawn as its buildings are, colored by block.
    expect((await layerById(page))['Buildings that share walls']).toMatchObject({ type: 'buildings', isColorMap: true, interpolator: 'interpolateTurbo' });
    await expectDrawn(page, 'map0');
});

test('charts the ten largest blocks of largest-blocks, counted in autk-db after its clusters pass, and maps every block', async ({ page }) => {
    await run(page, 'largest-blocks');
    // The ten largest blocks of the pass's result, as the grammar keeps it, most buildings first, then by block.
    const blocks = await page.evaluate(async () => (await window.grammar.data.fidi_blocks).features.map((feature) => feature.properties?.compute?.block as number));
    const sizes = new Map<number, number>();
    for (const block of blocks) sizes.set(block, (sizes.get(block) ?? 0) + 1);
    const largest = [...sizes].sort(([a, n], [b, m]) => m - n || a - b).slice(0, 10).map(([block, n]) => `block ${block} ${n}`);
    expect(largest).toHaveLength(10);
    expect(sizes.get(Number(largest[0].split(' ')[1])), 'a block of several buildings').toBeGreaterThan(1);
    // The chart draws the rows the sql source counted in autk-db's copy of that result: the same ten.
    const bars = await page.evaluate(() => [...document.querySelectorAll('#plot rect.autkMark')]
        .map((bar) => (bar as Element & { __data__?: { block?: string; buildings?: number } }).__data__)
        .map((datum) => `${datum?.block} ${datum?.buildings}`));
    expect(bars.sort()).toEqual([...largest].sort());
    expect(await page.evaluate(() => window.plotAxisTitles())).toEqual(['Block', 'Buildings']);
    expect((await layerById(page))['Blocks of touching buildings']).toMatchObject({ type: 'buildings', isColorMap: true });
    await expectDrawn(page, 'map0');
    // Its y axis counts buildings, so its tick labels read as plain numbers, where autk-plot's default, SI prefixes, wrote
    // 0.5 as "500m". d3 ticks the axis at halves, so at least one tick falls between whole numbers.
    const [yTicks] = await page.evaluate(() => window.plotTicks('plot', '#axisY'));
    expect(yTicks.some(([value]) => !Number.isInteger(value)), 'a tick between whole numbers').toBe(true);
    for (const [value, text] of yTicks) expect(text).toBe(String(value));
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

    // The example draws the raster's extent as a polygon, its first layer, under the raster.
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
    // workspace's CRS, as a host that hands its own tables writes them. The pass reads them as the source gave them,
    // each part with its own outline, not as autk-db keeps them in its building model: read so before, they packed
    // three empty boxes, and every spot read a width of 0.
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

// A noon shadow pass over roads: each building, packed as the box of its outline, casts its shadow north as far as it
// is tall, and a road whose first point lies in a shadow is shaded. Every coordinate is measured from the road's first
// point, since an f32 holds World Mercator's coordinates, near 1e7 m, only to about a meter.
const NOON_SHADOWS: ComputeSpec = {
    dataRef: 'roads',
    attributes: { seg: 'geometry.coordinates' },
    attributeMatrices: { seg: { rows: 'auto', cols: 2 } },
    uniforms: { h: { fromFeature: { layer: 'parts', path: 'properties.height', iterate: 'batched', required: true } } },
    uniformMatrices: { o: { fromFeature: { layer: 'parts', path: 'geometry.coordinates.0', iterate: 'batched' }, cols: 2 } },
    outputColumnName: 'shaded',
    wgslFunction: [
        'let ox = seg[0u]; let oy = seg[1u];',
        'var shaded = 0.0;',
        'for (var i = 0u; i < u32(num_features); i++) {',
        '    let x0 = o[i * 8u] - ox; let y0 = o[i * 8u + 1u] - oy;',
        '    let x1 = o[i * 8u + 4u] - ox; let y1 = o[i * 8u + 5u] - oy;',
        '    if (x0 <= 0.0 && 0.0 <= x1 && y0 <= 0.0 && 0.0 <= y1 + h[i]) { shaded = 1.0; }',
        '}',
        'return shaded;',
    ],
} as unknown as ComputeSpec;

/**
 * A scene of the shadow pass, laid out in meters east and north of a corner: the ground first, since autk-db cuts each
 * table to the first polygon table it loads, then building parts 60 m tall and named roads. Written in World Mercator
 * meters, the workspace's CRS, a pass reads the parts as the source gave them; written in degrees, as autk-db keeps
 * them, one GeometryCollection per building with each part's tags in `properties.parts`.
 */
function shadowScene(crs: 'meters' | 'degrees', parts: Array<{ polygons: number[][]; height?: number }>,
    roads: Array<{ name: string; lines: number[][][] }>): DataSourceSpec[] {
    const [x0, y0, lon0, lat0] = [-8235000, 4946000, -71.1, 42.35];
    const at = ([dx, dy]: number[]) => (crs === 'meters'
        ? [x0 + dx, y0 + dy]
        : [lon0 + dx / (111320 * Math.cos((lat0 * Math.PI) / 180)), lat0 + dy / 110574]);
    // A rectangle `width` by `depth` meters with its south-west corner at (x, y), as a polygon's rings.
    const rectangle = (x: number, y: number, width: number, depth: number) =>
        [[[x, y], [x + width, y], [x + width, y + depth], [x, y + depth], [x, y]].map(at)];
    // A square of `side` meters at (x, 0).
    const square = ([x, side]: number[]) => rectangle(x, 0, side, side);
    const table = (outputTableName: string, features: Array<{ properties: Record<string, unknown>; geometry: unknown }>, layerType?: string) => ({
        type: 'geojson', outputTableName, ...(crs === 'meters' && { coordinateFormat: 'EPSG:3395' }), ...(layerType && { layerType }),
        geojsonObject: { type: 'FeatureCollection', features: features.map((feature) => ({ type: 'Feature', ...feature })) },
    });
    return [
        table('ground', [{ properties: {}, geometry: { type: 'Polygon', coordinates: rectangle(-500, -500, 2000, 1000) } }]),
        table('parts', parts.map(({ polygons, height = 60 }) => ({
            properties: { height },
            geometry: polygons.length === 1
                ? { type: 'Polygon', coordinates: square(polygons[0]) }
                : { type: 'MultiPolygon', coordinates: polygons.map(square) },
        })), 'buildings'),
        table('roads', roads.map(({ name, lines }) => ({
            properties: { name },
            geometry: lines.length === 1
                ? { type: 'LineString', coordinates: lines[0].map(at) }
                : { type: 'MultiLineString', coordinates: lines.map((line) => line.map(at)) },
        })), 'roads'),
    ] as unknown as DataSourceSpec[];
}

/** Each road's `compute.shaded`, by its name. */
async function shadedRoads(page: Page): Promise<Record<string, unknown>> {
    return page.evaluate(async () => {
        const roads = await window.grammar.data.roads;
        return Object.fromEntries(roads.features.map((feature) => [String(feature.properties?.name), (feature.properties?.compute as Record<string, unknown> | undefined)?.shaded]));
    });
}

for (const crs of ['meters', 'degrees'] as const) {
    test(`a building part of two polygons shades the road by each of them, as a part of one polygon does (written in ${crs})`, async ({ page }) => {
        // A part OpenStreetMap maps as one element of two polygons, 40 m squares 400 m apart, a tower of the same
        // square 400 m further east, a road 10 m north of each square, and a road in the open. Its MultiPolygon's
        // geometry.coordinates.0 is its first polygon, not a ring: the pass packed it as a box of zeros, and neither
        // road by it was shaded. Read as autk-db keeps it, every part packed one.
        await runSpec(page, {
            data: shadowScene(crs, [{ polygons: [[0, 40], [400, 40]] }, { polygons: [[800, 40]] }], [
                { name: 'by the first polygon', lines: [[[20, 50], [40, 50]]] },
                { name: 'by the second polygon', lines: [[[420, 50], [440, 50]]] },
                { name: 'by the tower', lines: [[[820, 50], [840, 50]]] },
                { name: 'in the open', lines: [[[1220, 50], [1240, 50]]] },
            ]),
            compute: [NOON_SHADOWS],
        } as unknown as UrbanSpec);
        expect(await shadedRoads(page)).toEqual({
            'by the first polygon': 1, 'by the second polygon': 1, 'by the tower': 1, 'in the open': 0,
        });
    });
}

test('a road of two lines is shaded by the building beside its first line, and keeps both lines', async ({ page }) => {
    // autk-compute packs a matrix attribute row by row from geometry.coordinates, and a MultiLineString's rows are
    // lines, not points: it packed the road as zeros, a road at World Mercator's origin, which nothing shades.
    await runSpec(page, {
        data: shadowScene('meters', [{ polygons: [[0, 40]] }], [
            { name: 'two lines', lines: [[[20, 50], [40, 50]], [[300, 50], [320, 50]]] },
            { name: 'one line', lines: [[[10, 55], [30, 55]]] },
            { name: 'in the open', lines: [[[1220, 50], [1240, 50]]] },
        ]),
        compute: [NOON_SHADOWS],
    } as unknown as UrbanSpec);
    expect(await shadedRoads(page)).toEqual({ 'two lines': 1, 'one line': 1, 'in the open': 0 });
    // The pass's result keeps the road's two lines as autk-db keeps them, which a map draws.
    const geometries = await page.evaluate(async () => {
        const named = (collection: { features: Array<{ properties: Record<string, unknown> | null; geometry: unknown }> }) =>
            collection.features.find((feature) => feature.properties?.name === 'two lines')?.geometry;
        return { result: named(await window.grammar.data.roads), kept: named(await window.dbLayer('roads')) };
    });
    expect((geometries.result as { type: string }).type).toBe('MultiLineString');
    expect(geometries.result).toEqual(geometries.kept);
});

test('draws the Financial District of map-style in the colors of its night style, without the floating menu and legend', async ({ page }) => {
    const { tables } = await run(page, 'map-style');
    expect(tables.fidi_buildings.features).toBeGreaterThan(50);
    expect((await mapLayers(page)).map((layer) => layer.type)).toEqual(expect.arrayContaining(['surface', 'roads', 'buildings']));
    expect(await page.evaluate(() => window.mapUi('map0'))).toEqual({ menu: false, legend: false, credit: true });
    // The ground and the roads in the style's colors, which no preset of autk-map has.
    expect(await pixelsIn(page, '#13263a', 'surface at night')).toBeGreaterThan(5000);
    expect(await pixelsIn(page, '#4a6584', 'roads at night')).toBeGreaterThan(100);
    await expectDrawn(page, 'map0');
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
