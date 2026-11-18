import { AutkGrammar } from '@urban-toolkit/autk-grammar';
import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMap } from '@urban-toolkit/autk-core';
import type { ColorMapInterpolator, ColorRGB } from '@urban-toolkit/autk-core';
import { AutkMap } from '@urban-toolkit/autk-map';
import type { FeatureCollection, Geometry } from 'geojson';

export type TableSummary = { features: number; properties: string[] };
export type RunSummary = { tables: Record<string, TableSummary>; plotSvgs: number };

/** A pane the gallery hub's code made: the id of the element its view draws in, its view's `id`, and its box on the page. */
export type PaneBox = { target: string; viewId: string | null; left: number; top: number; width: number; height: number };

/** What autk-map holds for one layer of a map. */
export type LayerState = {
    id: string;
    type: string;
    color?: ColorRGB;
    strokeColor?: ColorRGB;
    showBorders?: boolean;
    polylinesWidth?: number;
    pointSize?: number;
    isColorMap?: boolean;
    isPick?: boolean;
    interpolator: string;
    domain?: Array<number | string>;
    labels?: string[];
    highlightedIds?: number[];
};

/** A map's legend as the page shows it: its heading, its labels left to right, and whether it shows. */
export type LegendState = { title: string | null; labels: string[]; visible: boolean };

const examples = import.meta.glob<{ spec: UrbanSpec }>('../../gallery/src/examples/*.ts');

function element(tag: 'canvas' | 'div', id: string): HTMLElement {
    const el = document.createElement(tag);
    el.id = id;
    document.getElementById('stage')!.appendChild(el);
    return el;
}

declare global {
    interface Window {
        grammar: AutkGrammar;
        runSpec: (spec: UrbanSpec, plotTargets?: 'one' | 'each') => Promise<RunSummary>;
        runInPanes: (spec: UrbanSpec, width: number, height: number) => Promise<{ targets: Record<string, unknown>; panes: PaneBox[] }>;
        runAgain: (spec: UrbanSpec) => Promise<void>;
        runExample: (name: string) => Promise<RunSummary>;
        exampleSpec: (name: string) => Promise<UrbanSpec>;
        valueAt: (table: string, index: number, path: string) => Promise<unknown>;
        featureExtents: (table: string) => Promise<number[][]>;
        readMap: (canvasId: string) => Promise<string>;
        mapLayers: (canvasId: string) => LayerState[];
        drawnRows: (canvasId: string, layerId: string) => Array<Record<string, unknown> | null>;
        cameraState: (canvasId: string) => { eye: number[]; lookAt: number[] };
        rasterCells: (canvasId: string, layerId: string) => { values: number[]; rgba: number[] };
        legend: () => LegendState | null;
        schemeColor: (value: number, interpolator: string, domain: number[]) => ColorRGB;
        domainLabels: (domain: number[]) => string[];
    }
}

function mapOn(canvasId: string): AutkMap {
    const map = window.grammar.maps.find((m) => m.canvas.id === canvasId);
    if (!map) throw new Error(`No map draws on #${canvasId}`);
    return map;
}

/**
 * The collection autk-map was handed for each layer of each map, recorded as autk-map loads it, so a test reads what a
 * map draws from what autk-map itself was given rather than from the grammar.
 */
const handed = new WeakMap<AutkMap, Map<string, FeatureCollection>>();
const loadCollection = AutkMap.prototype.loadCollection;
AutkMap.prototype.loadCollection = function (this: AutkMap, ...args: Parameters<AutkMap['loadCollection']>) {
    const [layerId, { collection }] = args;
    if (!handed.has(this)) handed.set(this, new Map());
    handed.get(this)!.set(layerId, collection as FeatureCollection);
    return loadCollection.apply(this, args);
};

/**
 * The spec of a gallery example, loaded in the page, so a test can run it changed. The examples that name an enum
 * import the grammar at run time, which the test process cannot do: it never builds the grammar.
 */
window.exampleSpec = async (name: string) => {
    const load = examples[`../../gallery/src/examples/${name}.ts`];
    if (!load) throw new Error(`No gallery example named ${name}`);
    return (await load()).spec;
};

/** Runs a gallery example spec. */
window.runExample = async (name: string) => window.runSpec(await window.exampleSpec(name));

/**
 * Runs a spec, creating a canvas per map and a div for the plots: one div, `#plot`, that holds them all, or with
 * `plotTargets: 'each'` one div per plot, `#plot0`, `#plot1`, and so on. The grammar of the previous run is
 * destroyed first, so its maps release their GPU textures and buffers and their event handlers. (autk-map's maps
 * share one GPU device, which stays.)
 */
window.runSpec = async (spec: UrbanSpec, plotTargets: 'one' | 'each' = 'one') => {
    window.grammar?.destroy();
    document.getElementById('stage')!.innerHTML = '';
    const maps = Array.isArray(spec.map) ? spec.map.map((_, i) => `map${i}`) : spec.map ? ['map0'] : [];
    maps.forEach((id) => element('canvas', id));
    const plotCount = spec.plot === undefined ? 0 : Array.isArray(spec.plot) ? spec.plot.length : 1;
    const plotIds = plotTargets === 'each' ? Array.from({ length: plotCount }, (_, i) => `plot${i}`) : plotCount ? ['plot'] : [];
    plotIds.forEach((id) => element('div', id));

    const grammar = new AutkGrammar({
        ...(maps.length && { map: Array.isArray(spec.map) ? maps : maps[0] }),
        ...(plotIds.length && { plot: plotTargets === 'each' ? plotIds : 'plot' }),
    });
    window.grammar = grammar;
    await grammar.run(spec);

    const tables: Record<string, TableSummary> = {};
    for (const table of Object.keys(grammar.data)) {
        const collection = await grammar.data[table];
        tables[table] = {
            features: collection.features.length,
            properties: Object.keys(collection.features[0]?.properties ?? {}),
        };
    }
    return { tables, plotSvgs: document.querySelectorAll(plotTargets === 'each' ? '[id^="plot"] svg' : '#plot svg').length };
};

/**
 * Runs a spec in the panes the gallery hub builds for a spec with a layout (gallery/src/views.ts, which places each
 * view as `arrangeViews` says), in a stage of `width` by `height` pixels. Returns the grammar's targets and each pane's
 * box, once the views are drawn. The hub's code is loaded here, so only the tests that ask for it depend on it.
 */
window.runInPanes = async (spec: UrbanSpec, width: number, height: number) => {
    const { createPanes } = await import('../../gallery/src/views');
    window.grammar?.destroy();
    const stage = document.getElementById('stage')!;
    stage.innerHTML = '';
    const { element, targets } = createPanes(spec, 'canvas');
    Object.assign(element.style, { width: `${width}px`, height: `${height}px` });
    stage.appendChild(element);

    const grammar = new AutkGrammar(targets);
    window.grammar = grammar;
    await grammar.run(spec);

    const panes = [...element.querySelectorAll<HTMLElement>('.view-pane')].map((pane) => {
        const box = pane.getBoundingClientRect();
        return {
            target: pane.firstElementChild?.id ?? '',
            viewId: pane.dataset.viewId ?? null,
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
        };
    });
    return { targets, panes };
};

/**
 * Runs a spec on the grammar of the last run, in the elements that run made, as a host that keeps one `AutkGrammar`
 * does: the grammar destroys the last run's maps itself, and the plot elements are emptied first.
 */
window.runAgain = async (spec: UrbanSpec) => {
    document.querySelectorAll('#stage [id^="plot"]').forEach((element) => { element.innerHTML = ''; });
    await window.grammar.run(spec);
};

/** Reads a (dot path) property of one feature, e.g. valueAt('neighborhoods', 0, 'sjoin.count.noise'). */
window.valueAt = async (table: string, index: number, path: string) => {
    const collection = await window.grammar.data[table];
    return path.split('.').reduce<unknown>(
        (value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]),
        collection.features[index]?.properties,
    );
};

/** Each feature's extent as [minX, minY, maxX, maxY], in workspace coordinates (World Mercator meters). */
window.featureExtents = async (table: string) => {
    const collection = await window.grammar.data[table];
    return collection.features.map((feature) => {
        const extent = [Infinity, Infinity, -Infinity, -Infinity];
        const visit = (value: unknown): void => {
            if (!Array.isArray(value)) return;
            if (typeof value[0] !== 'number') {
                value.forEach(visit);
                return;
            }
            extent[0] = Math.min(extent[0], value[0]);
            extent[1] = Math.min(extent[1], value[1]);
            extent[2] = Math.max(extent[2], value[0]);
            extent[3] = Math.max(extent[3], value[1]);
        };
        const walk = (geometry: Geometry | null): void => {
            if (geometry?.type === 'GeometryCollection') geometry.geometries.forEach(walk);
            else if (geometry) visit(geometry.coordinates);
        };
        walk(feature.geometry);
        return extent;
    });
};

/**
 * Reads a map canvas as a PNG data URL, in the animation frame that draws the map.
 *
 * A map draws on demand, and Chrome can read an idle WebGPU canvas back as transparent. So this
 * asks the map for one frame and reads the canvas in an animation frame callback registered after
 * the map's own, which runs in the same frame, before the frame is shown. requestRender() does
 * nothing for a map whose draw() never ran, so such a map reads back blank.
 */
window.readMap = (canvasId: string) => {
    const map = mapOn(canvasId);
    map.requestRender();
    return new Promise<string>((resolve) => requestAnimationFrame(() => resolve(map.canvas.toDataURL('image/png'))));
};

/** Where the camera of the map on #canvasId is and what it looks at. */
window.cameraState = (canvasId: string) => {
    const { camera } = mapOn(canvasId);
    return { eye: [...camera.getEye()], lookAt: [...camera.getLookAt()] };
};

/** The render state autk-map holds for each layer of the map on #canvasId, in its layer order. */
window.mapLayers = (canvasId: string) => mapOn(canvasId).layerManager.layers.map((layer) => {
    const info = layer.layerRenderInfo;
    const highlighted = (layer as unknown as { highlightedIds?: number[] }).highlightedIds;
    return {
        id: layer.layerInfo.id,
        type: layer.layerInfo.typeLayer,
        color: info.color,
        strokeColor: info.strokeColor,
        showBorders: info.showBorders,
        polylinesWidth: info.polylinesWidth,
        pointSize: info.pointSize,
        isColorMap: info.isColorMap,
        isPick: info.isPick,
        interpolator: info.colormap.config.interpolator,
        domain: info.colormap.computedDomain ? [...info.colormap.computedDomain] : undefined,
        labels: info.colormap.computedLabels ? [...info.colormap.computedLabels] : undefined,
        highlightedIds: highlighted ? [...highlighted] : undefined,
    };
});

/**
 * The properties of the feature a vector layer of the map on #canvasId draws at each of its positions, the positions
 * its picks and highlights name. autk-map draws each feature it was handed as one component, and none for a feature
 * with nothing to draw; a component names its feature by its index among those handed.
 */
window.drawnRows = (canvasId: string, layerId: string) => {
    const map = mapOn(canvasId);
    const collection = handed.get(map)?.get(layerId);
    const layer = map.layerManager.searchByLayerId(layerId) as unknown as { components?: Array<{ featureIndex: number }> } | null;
    if (!collection || !layer?.components) throw new Error(`#${canvasId} draws no vector layer ${layerId}`);
    return layer.components.map((component) => collection.features[component.featureIndex]?.properties ?? null);
};

/** A raster layer's cell values and the RGBA autk-map colors its cells with (four 0..255 values a cell). */
window.rasterCells = (canvasId: string, layerId: string) => {
    const layer = mapOn(canvasId).layerManager.searchByLayerId(layerId) as unknown as
        { rasterValues?: Float32Array; rasterData?: Float32Array } | null;
    if (!layer?.rasterValues || !layer.rasterData) throw new Error(`#${canvasId} has no raster layer ${layerId}`);
    return { values: Array.from(layer.rasterValues), rgba: Array.from(layer.rasterData) };
};

/** The legend of the page's map. */
window.legend = () => {
    const el = document.querySelector<HTMLElement>('#autkMapLegend');
    if (!el) return null;
    return {
        title: el.firstElementChild?.textContent ?? null,
        labels: Array.from(el.querySelectorAll('text'), (t) => t.textContent ?? ''),
        visible: el.style.visibility !== 'hidden',
    };
};

/** autk-core's color for a value on a scheme over a domain, as autk-map colors a raster cell. */
window.schemeColor = (value: number, interpolator: string, domain: number[]) =>
    ColorMap.getColor(value, interpolator as ColorMapInterpolator, domain as [number, number]);

/** autk-core's legend labels for a domain. */
window.domainLabels = (domain: number[]) => ColorMap.computeLabels(domain);
