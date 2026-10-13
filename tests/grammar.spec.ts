import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { ColorMapInterpolator, DataSourceSpec, MapLayerSpec, MapSpec, PlotSpec, UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import type { LayerState, RunSummary } from './app/main';
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

function runSpec(page: Page, spec: UrbanSpec): Promise<RunSummary> {
    return page.evaluate((s) => window.runSpec(s), spec);
}

/**
 * Fails when a map canvas is a single flat color, i.e. nothing was drawn. Reads the canvas
 * itself (window.readMap), in the frame that draws the map, so the map's controls and
 * watermark on top of it are not counted.
 */
async function expectDrawn(page: Page, canvasId: string) {
    await page.waitForTimeout(1500);
    const dataUrl = await page.evaluate((id) => window.readMap(id), canvasId);
    const image = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    await test.info().attach(`${canvasId}.png`, { body: image, contentType: 'image/png' });
    const png = PNG.sync.read(image);
    const colors = new Set<number>();
    for (let i = 0; i < png.data.length && colors.size < 16; i += 4 * 97) {
        colors.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
    }
    expect(colors.size, `#${canvasId} looks blank`).toBeGreaterThan(8);
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
            wglsFunction: [
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

// Layer options: small inline tables in Midtown Manhattan. `zones` and `blocks` are four squares
// each, `paths` three east-west lines.
function squares(name: string, y: number): DataSourceSpec {
    const square = (i: number) => {
        const x = -73.99 + i * 0.004;
        return { type: 'Polygon' as const, coordinates: [[[x, y], [x + 0.003, y], [x + 0.003, y + 0.003], [x, y + 0.003], [x, y]]] };
    };
    return {
        type: 'geojson',
        outputTableName: name,
        geojsonObject: {
            type: 'FeatureCollection',
            features: [0, 1, 2, 3].map((i) => ({ type: 'Feature' as const, properties: { id: i, v: i * 10 }, geometry: square(i) })),
        },
    };
}
const zones = squares('zones', 40.75);
const blocks = squares('blocks', 40.756);
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

function mapLayers(page: Page, canvasId = 'map0'): Promise<LayerState[]> {
    return page.evaluate((id) => window.mapLayers(id), canvasId);
}

async function layerById(page: Page, canvasId = 'map0'): Promise<Record<string, LayerState>> {
    return Object.fromEntries((await mapLayers(page, canvasId)).map((layer) => [layer.id, layer]));
}

test('names a layer by its title, and the legend and the lookup by data name follow it', async ({ page }) => {
    await runSpec(page, {
        data: [zones, paths],
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
        data: [zones, paths],
        map: { layerRefs: [{ dataRef: 'zones', title: 'Same' }, { dataRef: 'paths', title: 'Same' }] },
    })).rejects.toThrow('Map 0 draws two layers with the id "Same"');
    // A title is a layer id, so it cannot be another layer's dataRef in the same map.
    await expect(runSpec(page, {
        data: [zones, paths],
        map: { layerRefs: [{ dataRef: 'zones', title: 'paths' }, { dataRef: 'paths' }] },
    })).rejects.toThrow('Map 0 draws two layers with the id "paths"');

    await runSpec(page, {
        data: [zones, paths],
        map: [{ layerRefs: [{ dataRef: 'zones', title: 'Same' }] }, { layerRefs: [{ dataRef: 'paths', title: 'Same' }] }],
    });
    expect((await mapLayers(page, 'map0')).map((layer) => layer.id)).toEqual(['Same']);
    expect((await mapLayers(page, 'map1')).map((layer) => layer.id)).toEqual(['Same']);
});

test('highlights a titled layer, and links it to a plot, by its data name', async ({ page }) => {
    await runSpec(page, {
        data: [zones],
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

test('draws a layer in its color, line width and outline', async ({ page }) => {
    await runSpec(page, {
        data: [zones, blocks, paths],
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

// Raster layers: the gallery's 30 x 30 noise heatmap, drawn over its neighborhoods.
const scheme = (name: string) => name as unknown as ColorMapInterpolator;
function heatmapWith(options: Partial<MapLayerSpec>): UrbanSpec {
    return {
        ...heatmapGeojson,
        map: { layerRefs: [{ dataRef: 'neighborhoods' }, { dataRef: 'heatmap', getFnv: 'count.noise', ...options }] },
    };
}

async function heatmapLayer(page: Page) {
    const layer = (await layerById(page)).heatmap;
    const { values } = await page.evaluate(() => window.rasterCells('map0', 'heatmap'));
    const finite = values.filter(Number.isFinite);
    expect(finite.length).toBeGreaterThan(0);
    return { layer, finite, min: Math.min(...finite), max: Math.max(...finite) };
}

/** Counts the heatmap cells with a value whose color is not the scheme's color for that value over *domain*. */
function cellsOffScheme(page: Page, interpolator: string, domain: number[]): Promise<{ colored: number; off: number }> {
    return page.evaluate(({ interpolator, domain }) => {
        const { values, rgba } = window.rasterCells('map0', 'heatmap');
        let colored = 0;
        let off = 0;
        values.forEach((value, i) => {
            if (!Number.isFinite(value)) return;
            colored++;
            const c = window.schemeColor(value, interpolator, domain);
            if (rgba[i * 4] !== c.r || rgba[i * 4 + 1] !== c.g || rgba[i * 4 + 2] !== c.b) off++;
        });
        return { colored, off };
    }, { interpolator, domain });
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
