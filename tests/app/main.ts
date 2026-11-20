import { AutkGrammar, applyCamera, playCameraMotion } from '@urban-toolkit/autk-grammar';
import type { CameraTour } from '@urban-toolkit/autk-grammar';
import type { CameraMotionStep, CameraSpec, UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMap } from '@urban-toolkit/autk-core';
import type { ColorMapInterpolator, ColorRGB } from '@urban-toolkit/autk-core';
import type { AutkDb } from '@urban-toolkit/autk-db';
import { AutkMap } from '@urban-toolkit/autk-map';
import { PlotStyle } from '@urban-toolkit/autk-plot';
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
    skippedIds?: number[];
    polylinesWidthByComponent?: number[];
};

/**
 * A map's terrain: the band autk-map was handed for it, the lowest and highest finite values of that band, and the
 * heightfield autk-map built from it: its cells across and down, its lowest and highest heights, and its bounds
 * `[minX, minY, maxX, maxY]` around the map's origin.
 */
export type TerrainState = {
    band: string;
    bandMin: number;
    bandMax: number;
    width: number;
    height: number;
    minHeight: number;
    maxHeight: number;
    bounds: number[];
};

/** A map's legend as the page shows it: its heading, its labels left to right, and whether it shows. */
export type LegendState = { title: string | null; labels: string[]; visible: boolean };

/**
 * Where a map's camera is, in the map's world: its eye, the point it looks at, its line of sight (a unit vector, read
 * from its view matrix) and its up direction, with the map's origin, the point of the workspace's CRS the world is
 * relative to.
 */
export type CameraView = { eye: number[]; lookAt: number[]; sight: number[]; up: number[]; origin: number[] };

/** A mark a plot draws: the row autk-plot binds to it, and its fill and stroke as the page computes them, `rgb(r, g, b)`. */
export type DrawnMark = { datum: Record<string, unknown> | null; fill: string; stroke: string };

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
        besideGrammar?: AutkGrammar;
        runSpec: (spec: UrbanSpec, plotTargets?: 'one' | 'each') => Promise<RunSummary>;
        runBeside: (spec: UrbanSpec) => Promise<void>;
        plotStyle: () => { markColor: string; highlightColor: string };
        runInPanes: (spec: UrbanSpec, width: number, height: number, styles?: 'hub') => Promise<{ targets: Record<string, unknown>; panes: PaneBox[] }>;
        runAgain: (spec: UrbanSpec) => Promise<void>;
        runExample: (name: string) => Promise<RunSummary>;
        exampleSpec: (name: string) => Promise<UrbanSpec>;
        valueAt: (table: string, index: number, path: string) => Promise<unknown>;
        featureExtents: (table: string) => Promise<number[][]>;
        dbRows: (query: string) => Promise<Array<Record<string, unknown>>>;
        dbLayer: (table: string, osmElements?: boolean) => Promise<FeatureCollection>;
        readMap: (canvasId: string) => Promise<string>;
        mapLayers: (canvasId: string) => LayerState[];
        drawnRows: (canvasId: string, layerId: string) => Array<Record<string, unknown> | null>;
        cameraState: (canvasId: string) => { eye: number[]; lookAt: number[] };
        cameraView: (canvasId: string) => CameraView;
        turnCamera: (canvasId: string, camera: CameraSpec) => void;
        playTour: (canvasId: string, motion: CameraMotionStep[]) => void;
        tour?: CameraTour;
        tourEnded?: boolean;
        rasterCells: (canvasId: string, layerId: string) => { values: number[]; rgba: number[] };
        handedBand: (canvasId: string, layerId: string, band: string) => number[];
        handedBbox: (canvasId: string, layerId: string) => number[];
        mapOrigin: (canvasId: string) => number[];
        terrain: (canvasId: string) => TerrainState | null;
        buildingTops: (canvasId: string, layerId: string) => Array<number | null>;
        mapUi: (canvasId: string) => { menu: boolean; legend: boolean; credit: boolean };
        legend: () => LegendState | null;
        plotMarks: (target?: string) => DrawnMark[];
        plotTicks: (target: string, selector: string) => Array<Array<[unknown, string]>>;
        plotAxisTitles: (target?: string) => string[];
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

/** The raster collection and the band's path autk-map was handed for the terrain of each map, recorded as it builds it. */
const terrains = new WeakMap<AutkMap, { collection: FeatureCollection; property: string }>();
const enableTerrainMode = AutkMap.prototype.enableTerrainMode;
AutkMap.prototype.enableTerrainMode = function (this: AutkMap, ...args: Parameters<AutkMap['enableTerrainMode']>) {
    const [collection, property] = args;
    terrains.set(this, { collection: collection as FeatureCollection, property });
    return enableTerrainMode.apply(this, args);
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
 * box, once the views are drawn. The hub's code is loaded here, so only the tests that ask for it depend on it. With
 * `styles: 'hub'` the page also takes the hub's stylesheet, which restyles the page's body and stage, as the hub does.
 */
window.runInPanes = async (spec: UrbanSpec, width: number, height: number, styles?: 'hub') => {
    if (styles === 'hub') await import('../../gallery/src/hub.css');
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
 * Runs a spec on a second grammar of the page, whose plots draw in a div of their own, #beside, as a page that shows
 * two specs does. The grammar of runSpec stays; the last second grammar is destroyed first.
 */
window.runBeside = async (spec: UrbanSpec) => {
    window.besideGrammar?.destroy();
    document.getElementById('beside')?.remove();
    element('div', 'beside');
    const grammar = new AutkGrammar({ plot: 'beside' });
    window.besideGrammar = grammar;
    await grammar.run(spec);
};

/** The mark and highlight colors autk-plot holds for the whole page (`PlotStyle`). */
window.plotStyle = () => ({ markColor: PlotStyle.default, highlightColor: PlotStyle.highlight });

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
 * The autk-db database of the last run. The grammar keeps it as its engine's context and does not expose it, so a test
 * reads autk-db's own tables, apart from the grammar's caches, through it.
 */
function lastDb(): AutkDb {
    const db = (window.grammar as unknown as { grammarEngine?: { context?: AutkDb } }).grammarEngine?.context;
    if (!db) throw new Error('The last run made no database.');
    return db;
}

/** The rows a SELECT over the last run's tables gives in autk-db, in the default workspace, with counts as numbers. */
window.dbRows = async (query: string) => {
    const rows = await lastDb().rawQuery({ query, output: { type: 'RETURN_OBJECT' } }) as Array<Record<string, unknown>>;
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value])));
};

/** A table as autk-db exports it, not as the grammar's caches hold it; with `osmElements`, one feature per OSM element. */
window.dbLayer = (table: string, osmElements?: boolean) => lastDb().getLayer(table, osmElements ? { osmElements: true } : undefined);

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

/**
 * Where the camera of the map on #canvasId is, with its line of sight, its up direction and the map's origin. The line
 * of sight comes from the view matrix: a tour's roll leaves the point the camera looks at one unit from the eye, too near
 * for float32 coordinates to give the direction.
 */
window.cameraView = (canvasId: string) => {
    const map = mapOn(canvasId);
    const { camera } = map;
    camera.update();
    const matrix = camera.getModelViewMatrix();
    return {
        eye: [...camera.getEye()],
        lookAt: [...camera.getLookAt()],
        sight: [-matrix[2], -matrix[6], -matrix[10]],
        up: [...camera.getUp()],
        origin: [...map.layerManager.origin],
    };
};

/** Turns the camera of the map on #canvasId with the grammar's `applyCamera`, as a host does. */
window.turnCamera = (canvasId: string, camera: CameraSpec) => applyCamera(mapOn(canvasId), camera);

/**
 * Plays a camera tour on the map on #canvasId with the grammar's `playCameraMotion`, as a host does. `window.tour` holds
 * the tour, and `window.tourEnded` turns true once its `done` settles.
 */
window.playTour = (canvasId: string, motion: CameraMotionStep[]) => {
    const tour = playCameraMotion(mapOn(canvasId), motion);
    window.tour = tour;
    window.tourEnded = false;
    void tour.done.then(() => {
        if (window.tour === tour) window.tourEnded = true;
    });
};

/**
 * The positions of the features a layer hides, in order, read with autk-map's public getters: a vector layer gives them
 * (`skippedIds`); a points layer gives which of its point instances are hidden (`skippedVertices`), and each of its
 * features (`components`) holds the instances up to its running count `nPoints`. Undefined for a layer that hides none
 * of either kind, a raster.
 */
function skippedIdsOf(layer: unknown): number[] | undefined {
    const { skippedIds, skippedVertices, components } = layer as
        { skippedIds?: number[]; skippedVertices?: Float32Array; components?: Array<{ nPoints: number }> };
    if (Array.isArray(skippedIds)) return [...skippedIds].sort((a, b) => a - b);
    if (!skippedVertices || !Array.isArray(components)) return undefined;
    return components.flatMap((component, position) => {
        const first = position > 0 ? components[position - 1].nPoints : 0;
        return first < component.nPoints && skippedVertices[first] > 0 ? [position] : [];
    });
}

/** The render state autk-map holds for each layer of the map on #canvasId, in its layer order. */
window.mapLayers = (canvasId: string) => mapOn(canvasId).layerManager.layers.map((layer) => {
    const info = layer.layerRenderInfo;
    const highlighted = (layer as unknown as { highlightedIds?: number[] }).highlightedIds;
    const skipped = skippedIdsOf(layer);
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
        skippedIds: skipped,
        polylinesWidthByComponent: info.polylinesWidthByComponent ? [...info.polylinesWidthByComponent] : undefined,
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

/** The values of a band of the raster collection autk-map was handed for a layer of the map on #canvasId. */
window.handedBand = (canvasId: string, layerId: string, band: string) => {
    const collection = handed.get(mapOn(canvasId))?.get(layerId);
    const values = (collection?.features[0]?.properties as Record<string, unknown> | null | undefined)?.[band];
    if (!values) throw new Error(`#${canvasId} was handed no band ${band} for ${layerId}`);
    return Array.from(values as ArrayLike<number>);
};

/** The `bbox` of the collection autk-map was handed for a layer of the map on #canvasId, such as a raster's extent. */
window.handedBbox = (canvasId: string, layerId: string) => {
    const bbox = handed.get(mapOn(canvasId))?.get(layerId)?.bbox;
    if (!bbox) throw new Error(`#${canvasId} was handed no bbox for ${layerId}`);
    return [...bbox];
};

/** The origin of the map on #canvasId, from which autk-map draws every layer: the middle of the first collection it loaded. */
window.mapOrigin = (canvasId: string) => [...mapOn(canvasId).layerManager.origin];

/**
 * The top of each building a buildings layer of the map on #canvasId draws, one per feature it was handed, at its
 * positions: the highest height of the feature's vertices, or null when autk-map draws none of its parts.
 */
window.buildingTops = (canvasId: string, layerId: string) => {
    const layer = mapOn(canvasId).layerManager.searchByLayerId(layerId) as unknown as
        { position?: Float32Array; components?: Array<{ nPoints: number }> } | null;
    const position = layer?.position;
    if (!position || !layer.components) throw new Error(`#${canvasId} draws no buildings layer ${layerId}`);
    let first = 0;
    return layer.components.map(({ nPoints }) => {
        // A component's nPoints counts the vertices up to its own last, x, y and height each.
        let top: number | null = null;
        for (let vertex = first; vertex < nPoints; vertex++) top = Math.max(top ?? -Infinity, position[vertex * 3 + 2]);
        first = nPoints;
        return top;
    });
};

/**
 * Which of autk-map's floating elements the map on #canvasId put next to its canvas: its menu, its legend and its
 * "made with autark" credit. autk-map adds them to the canvas's parent, which every map of this page shares.
 */
window.mapUi = (canvasId: string) => {
    const parent = mapOn(canvasId).canvas.parentElement;
    return {
        menu: parent?.querySelector('#autkMapUi') != null,
        legend: parent?.querySelector('#autkMapLegend') != null,
        credit: parent?.querySelector('.autk-map-branding') != null,
    };
};

/**
 * The terrain of the map on #canvasId, or null when it draws none (see `TerrainState`). autk-map 4.1.1 gives no public
 * getter for a terrain's heightfield, so this reads the one its terrain render path keeps (`_terrainRenderPath`).
 */
window.terrain = (canvasId: string) => {
    const map = mapOn(canvasId);
    const path = (map as unknown as { _terrainRenderPath?: { heightfield?: Omit<TerrainState, 'band' | 'bandMin' | 'bandMax'> } | null })._terrainRenderPath;
    const handedTerrain = terrains.get(map);
    if (!path?.heightfield || !handedTerrain) return null;
    const values = (handedTerrain.collection.features[0]?.properties as Record<string, ArrayLike<number>> | null)?.[handedTerrain.property] ?? [];
    let bandMin = Infinity;
    let bandMax = -Infinity;
    for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) continue;
        bandMin = Math.min(bandMin, values[i]);
        bandMax = Math.max(bandMax, values[i]);
    }
    const { width, height, minHeight, maxHeight, bounds } = path.heightfield;
    return { band: handedTerrain.property, bandMin, bandMax, width, height, minHeight, maxHeight, bounds: [...bounds] };
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

/**
 * The elements `selector` finds inside the element whose id is `target`, the first of that id in the page. autk-plot
 * gives the svg of every plot the id `plot` too, so a selector `#plot ...` would also reach into another element's plot.
 */
function within(target: string, selector: string): Element[] {
    return Array.from(document.getElementById(target)?.querySelectorAll(selector) ?? []);
}

/**
 * The marks the plots in the element #target draw (every `.autkMark`: a point, a bar, a cell, a line or a table row),
 * in the page's order, each with the row autk-plot binds to it and its colors as the page computes them. A value autk-db
 * read as a BIGINT, such as a CSV table's whole numbers, comes back as a number.
 */
window.plotMarks = (target = 'plot') => within(target, '.autkMark').map((mark) => {
    const style = getComputedStyle(mark);
    const datum = (mark as Element & { __data__?: Record<string, unknown> }).__data__;
    return {
        datum: datum ? Object.fromEntries(Object.entries(datum).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value])) : null,
        fill: style.fill,
        stroke: style.stroke,
    };
});

/**
 * The tick labels of the axes the selector finds in the element #target (`#axisX`, `#axisY`, or parallel coordinates'
 * `.autkBrush[autkBrushId]`), axis by axis, each tick as the value d3 binds to it and the text it shows.
 */
window.plotTicks = (target: string, selector: string) => within(target, selector).map((axis) =>
    Array.from(axis.querySelectorAll('.tick'), (tick): [unknown, string] =>
        [(tick as Element & { __data__?: unknown }).__data__, tick.querySelector('text')?.textContent ?? '']));

/** The text of each axis title (`.axis-label`) of the plots in the element #target, in the page's order. */
window.plotAxisTitles = (target = 'plot') => within(target, '.axis-label').map((title) => title.textContent ?? '');

/** autk-core's color for a value on a scheme over a domain, as autk-map colors a raster cell. */
window.schemeColor = (value: number, interpolator: string, domain: number[]) =>
    ColorMap.getColor(value, interpolator as ColorMapInterpolator, domain as [number, number]);

/** autk-core's legend labels for a domain. */
window.domainLabels = (domain: number[]) => ColorMap.computeLabels(domain);
