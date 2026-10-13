import { AutkGrammar } from '@urban-toolkit/autk-grammar';
import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMap } from '@urban-toolkit/autk-core';
import type { ColorMapInterpolator, ColorRGB } from '@urban-toolkit/autk-core';
import type { AutkMap } from '@urban-toolkit/autk-map';

export type TableSummary = { features: number; properties: string[] };
export type RunSummary = { tables: Record<string, TableSummary>; plotSvgs: number };

/** What autk-map holds for one layer of a map. */
export type LayerState = {
    id: string;
    type: string;
    color?: ColorRGB;
    strokeColor?: ColorRGB;
    showBorders?: boolean;
    polylinesWidth?: number;
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
        runSpec: (spec: UrbanSpec) => Promise<RunSummary>;
        runExample: (name: string) => Promise<RunSummary>;
        valueAt: (table: string, index: number, path: string) => Promise<unknown>;
        readMap: (canvasId: string) => Promise<string>;
        mapLayers: (canvasId: string) => LayerState[];
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

/** Runs a gallery example spec. */
window.runExample = async (name: string) => {
    const load = examples[`../../gallery/src/examples/${name}.ts`];
    if (!load) throw new Error(`No gallery example named ${name}`);
    const { spec } = await load();
    return window.runSpec(spec);
};

/** Runs a spec, creating a canvas per map and a div for the plot. */
window.runSpec = async (spec: UrbanSpec) => {
    document.getElementById('stage')!.innerHTML = '';
    const maps = Array.isArray(spec.map) ? spec.map.map((_, i) => `map${i}`) : spec.map ? ['map0'] : [];
    maps.forEach((id) => element('canvas', id));
    if (spec.plot) element('div', 'plot');

    const grammar = new AutkGrammar({
        ...(maps.length && { map: Array.isArray(spec.map) ? maps : maps[0] }),
        ...(spec.plot && { plot: 'plot' }),
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
    return { tables, plotSvgs: document.querySelectorAll('#plot svg').length };
};

/** Reads a (dot path) property of one feature, e.g. valueAt('neighborhoods', 0, 'sjoin.count.noise'). */
window.valueAt = async (table: string, index: number, path: string) => {
    const collection = await window.grammar.data[table];
    return path.split('.').reduce<unknown>(
        (value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]),
        collection.features[index]?.properties,
    );
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
        isColorMap: info.isColorMap,
        isPick: info.isPick,
        interpolator: info.colormap.config.interpolator,
        domain: info.colormap.computedDomain ? [...info.colormap.computedDomain] : undefined,
        labels: info.colormap.computedLabels ? [...info.colormap.computedLabels] : undefined,
        highlightedIds: highlighted ? [...highlighted] : undefined,
    };
});

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
