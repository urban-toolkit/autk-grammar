import { DataAdapter, MapAdapter, PlotAdapter, ComputeAdapter, IEngine, PlotSpec, UrbanSpec, createEngine } from "@urban-toolkit/the-urban-grammar";
import { AutkDb, DEFAULT_WORKSPACE_COORDINATE_FORMAT } from "@urban-toolkit/autk-db";
import { MapEvent } from "@urban-toolkit/autk-map";
import type { AutkMap } from "@urban-toolkit/autk-map";
import type { MapEventData } from "@urban-toolkit/autk-map";
import { PlotEvent } from "@urban-toolkit/autk-plot";
import type { PlotEventData } from "@urban-toolkit/autk-plot";
import { FeatureCollection } from "geojson";
import { createDataAdapter } from "./adapters/data";
import { createMapAdapter } from "./adapters/map";
import { createPlotAdapter, linkPlotToLayer, plotKey } from "./adapters/plot";
import { layerIdOf } from "./adapters/map";
import { enterWorkspace } from "./workspace";
import { createComputeAdapter } from "./adapters/compute";
import { Targets, PlotRegistry, GeoJsonCache, ComputeCache, ComputeLayerTypes, GrammarEventEmitter } from "./types";
import type { GrammarMapLayer, GrammarPlotSelectionEvent, MapId } from "./types";
import { DrawnLayer, DrawnLayers, LayerExports, PlotLinks, PlotRows, addPlotLink, isOnMap, mapIdOf } from "./drawn";
import { translateIds } from "./rows";

function asList<T>(value: T[] | T | undefined): T[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * An id names one view: no two maps or plots may share one, and an id is never empty. A plot without an id is known
 * by its dataRef, so no two plots may be known by one name either: two plots of a table without ids, or a plot whose
 * id is the dataRef of a plot without one.
 */
function checkViewIds(spec: UrbanSpec): void {
    const seen = new Set<string>();
    for (const view of [...asList(spec.map), ...asList(spec.plot)]) {
        if (view.id === undefined) continue;
        if (view.id === '') throw new Error('A map or plot has an empty id.');
        if (seen.has(view.id)) throw new Error(`Two maps or plots have the id "${view.id}"; an id names one view.`);
        seen.add(view.id);
    }
    const plots = new Map<string, PlotSpec>();
    for (const plot of asList(spec.plot)) {
        const key = plotKey(plot);
        const known = plots.get(key);
        if (known)
            throw new Error(known.id === undefined && plot.id === undefined
                ? `Two plots of the table "${key}" have no id; give each plot an id.`
                : `A plot's id "${key}" is the dataRef of a plot without an id; give each plot an id.`);
        plots.set(key, plot);
    }
}

export class AutkGrammar {
    private dataAdapter?: DataAdapter;
    private mapAdapter?: MapAdapter;
    private plotAdapter?: PlotAdapter;
    private computeAdapter?: ComputeAdapter;
    private grammarEngine?: IEngine;
    private _computeCache: ComputeCache = new Map();
    private _computeTypes: ComputeLayerTypes = new Map();
    private _data: Record<string, Promise<FeatureCollection>> = {};
    private _layers: DrawnLayers = [];
    private _maps: AutkMap[] = [];
    private _plotRegistry: PlotRegistry = new Map();
    private _fwdCleanups: Array<() => void> = [];
    private _plotLinks: PlotLinks = new Map();
    private _plotRows: PlotRows = new Map();
    private _exports: LayerExports = new Map();
    /** Each GeoJSON table a run loaded and each table a join wrote, which its plots read before the database. */
    private _geojsonCache: GeoJsonCache = new Map();

    readonly interactions = new GrammarEventEmitter();

    constructor(targets?: Targets) {
        this.dataAdapter = createDataAdapter(targets, this._geojsonCache);
        this.mapAdapter = createMapAdapter(targets, this._layers, this._computeCache, this._maps, this._computeTypes, this._exports);
        this.plotAdapter = createPlotAdapter(targets, this._layers, this._plotRegistry, this._plotLinks, this._geojsonCache, this._computeCache, this._plotRows, this._exports);
        this.computeAdapter = createComputeAdapter(this._computeCache, this._computeTypes);
    }

    /**
     * The coordinate reference system autk-db stores a workspace's tables in, unless the spec's `workspaces` sets
     * another for it.
     *
     * Input data is expected in EPSG:4326 (WGS84) by default and is transformed
     * to this CRS on load. Consumers that prepare data for injection (e.g. by
     * serialising a GeoDataFrame) can read this value and reproject accordingly
     * instead of hard-coding a CRS string.
     */
    get workspaceCrs(): string {
        return DEFAULT_WORKSPACE_COORDINATE_FORMAT;
    }

    get data(): Record<string, Promise<FeatureCollection>> {
        return this._data;
    }

    /**
     * The maps the last {@link run} drew, one per `map` entry of the spec, in order.
     *
     * Each map draws on demand: one frame once its layers are loaded, then one each
     * time it changes. Between frames a map canvas can read back empty, so to read a
     * map's pixels (for example with `canvas.toDataURL()`), call its `requestRender()`
     * and read in a `requestAnimationFrame` callback registered after that call.
     */
    get maps(): readonly AutkMap[] {
        return this._maps;
    }

    /**
     * Every layer the maps of the last {@link run} draw for a table, found by the table's name (a layer's `dataRef`):
     * for each, the map that draws it and the layer's id in that map, which is its `title`, else its `dataRef`. The
     * maps come in the spec's order, each map's layers bottom first. Empty when no map draws the table.
     *
     * @param dataRef The table's name.
     * @param mapId The map to look in, by its {@link MapId}: a string names a map by its `id`, a number by its index in
     * the spec's `map` list. Without it, every map.
     */
    mapLayers(dataRef: string, mapId?: MapId): GrammarMapLayer[] {
        return this._layersOf(dataRef, mapId).map(({ map, layerId }) => ({ map, layerId }));
    }

    /**
     * The layer a map of the last {@link run} draws for a table, found by the table's name (a layer's `dataRef`):
     * the map that draws it, and the layer's id in that map, which is its `title`, else its `dataRef`.
     * `undefined` when no map draws the table. When several layers draw it, the last one, which is the last map's;
     * {@link mapLayers} lists them all.
     *
     * @param dataRef The table's name.
     * @param mapId The map to look in, by its {@link MapId}: a string names a map by its `id`, a number by its index in
     * the spec's `map` list. Without it, every map.
     *
     * @example
     * const layer = grammar.mapLayer('buildings');
     * layer?.map.updateRenderInfo(layer.layerId, { opacity: 0.5 });
     */
    mapLayer(dataRef: string, mapId?: MapId): GrammarMapLayer | undefined {
        return this.mapLayers(dataRef, mapId).pop();
    }

    /** The drawn layers of a table, on every map or on the one `mapId` names. */
    private _layersOf(dataRef: string, mapId?: MapId): DrawnLayer[] {
        return this._layers.filter((layer) => layer.dataRef === dataRef && isOnMap(layer, mapId));
    }

    /**
     * Releases what the last run created: every map (its layers' GPU buffers, its textures, its canvas context, the
     * controls it adds to the page and its event handlers) and the grammar's own registries, caches and event
     * forwarding. autk-map's maps share one GPU device, which stays for the maps of the next run. Call it before the
     * page or the container goes away; `run` calls it before it starts, so running a new spec on the same instance
     * does not leak the maps of the old one.
     */
    destroy(): void {
        for (const cleanup of this._fwdCleanups) cleanup();
        this._fwdCleanups = [];
        for (const map of this._maps) map.destroy();
        this._maps.length = 0;
        this._layers.length = 0;
        this._plotRegistry.clear();
        this._plotLinks.clear();
        this._plotRows.clear();
        this._exports.clear();
        this._geojsonCache.clear();
        this._computeCache.clear();
        this._computeTypes.clear();
        this.grammarEngine = undefined;
        this._data = {};
    }

    async run(spec: UrbanSpec) {
        if(!this.dataAdapter)
            throw new Error('Database adapter not initialized. Please call the constructor first.');

        if(!this.mapAdapter)
            throw new Error('Map engine not initialized. Please call the constructor first.');

        if(!this.plotAdapter)
            throw new Error('Plot adapter not initialized. Please call the constructor first.');

        if(!this.computeAdapter)
            throw new Error('Compute adapter not initialized. Please call the constructor first.');

        checkViewIds(spec);

        this.destroy();

        this.grammarEngine = createEngine({
            spec,
            adapters: {
                db: this.dataAdapter,
                map: this.mapAdapter,
                plot: this.plotAdapter,
                compute: this.computeAdapter
            }
        });

        await this.grammarEngine.run();
        const db = this.grammarEngine.context as AutkDb | undefined;
        // Leave the database in the default workspace, whose tables `data` lists.
        if (db) await enterWorkspace(db);
        this._wireLinks(spec);
        this._rewireInteractions(spec);

        if (!db) {
            console.warn('Grammar engine produced no data context.');
            this._data = {};
            return;
        }

        const dataObj: Record<string, Promise<FeatureCollection>> = {};
        for (const table of db.getLayersMetadata()) {
            Object.defineProperty(dataObj, table.name, {
                get: () => {
                    const computed = this._computeCache.get(table.name);
                    return computed ? Promise.resolve(computed) : db.getLayer(table.name);
                },
                enumerable: true,
                configurable: true,
            });
        }
        // A table a compute pass wrote under its own name is not in the database.
        for (const name of this._computeCache.keys()) {
            if (name in dataObj) continue;
            Object.defineProperty(dataObj, name, {
                get: () => Promise.resolve(this._computeCache.get(name)!),
                enumerable: true,
                configurable: true,
            });
        }
        this._data = dataObj;
    }

    /**
     * Highlights features on every layer that draws the table `dataRef`, in every map (see {@link mapLayers}), or only
     * in the map `mapId` names. If a plot is linked to one of those layers, by a link or its `mapRef`, the plot
     * selection is updated too, to the same rows: the plot finds them by their feature ids, since it can draw the
     * table's rows in another order and draws the rows without a geometry, which a layer leaves out.
     *
     * @param dataRef The table's name.
     * @param featureIds The features to highlight: their positions among those the layer draws.
     * @param mapId The map to highlight on, by its {@link MapId}: a string names a map by its `id`, a number by its
     * index in the spec's `map` list. Without it, every map that draws the table.
     */
    highlightOnMap(dataRef: string, featureIds: number[], mapId?: MapId): void {
        const layers = this._layersOf(dataRef, mapId);
        for (const { map, layerId } of layers) map.setHighlightedIds(layerId, featureIds);
        this._selectInLinkedPlots(layers, featureIds);
    }

    /**
     * Clears highlighted features on every layer that draws the table `dataRef`, in every map (see {@link mapLayers}),
     * or only in the map `mapId` names. If a plot is linked to one of those layers, by a link or its `mapRef`, the plot
     * selection is cleared too.
     *
     * @param dataRef The table's name.
     * @param mapId The map to clear, by its {@link MapId}: a string names a map by its `id`, a number by its index in
     * the spec's `map` list. Without it, every map that draws the table.
     */
    clearHighlightOnMap(dataRef: string, mapId?: MapId): void {
        const layers = this._layersOf(dataRef, mapId);
        for (const { map, layerId } of layers) map.clearHighlightedIds(layerId);
        this._selectInLinkedPlots(layers, []);
    }

    /**
     * Clears the selection on the plot `plotId` names: its `id`, else its `dataRef`.
     * If that plot is linked to map layers, by links or its `mapRef`, their highlights are cleared too: on every map,
     * or only on the map `mapId` names.
     *
     * @param plotId The plot: its `id`, else its `dataRef`.
     * @param mapId The map whose linked layers to clear, by its {@link MapId}: a string names a map by its `id`, a
     * number by its index in the spec's `map` list. Without it, every linked layer.
     */
    clearHighlightOnPlot(plotId: string, mapId?: MapId): void {
        this._plotRegistry.get(plotId)?.setSelection([]);
        for (const layer of this._plotLinks.get(plotId) ?? []) {
            if (isOnMap(layer, mapId)) layer.map.clearHighlightedIds(layer.layerId);
        }
    }

    /**
     * Applies a selection to the plot `plotId` names: its `id`, else its `dataRef`.
     * If that plot is linked to map layers, by links or its `mapRef`, their highlights are updated too, to the same rows
     * (see {@link highlightOnMap}): on every map, or only on the map `mapId` names.
     *
     * @param plotId The plot: its `id`, else its `dataRef`.
     * @param featureIds The features to select: their positions among those the plot draws.
     * @param mapId The map whose linked layers to highlight, by its {@link MapId}: a string names a map by its `id`, a
     * number by its index in the spec's `map` list. Without it, every linked layer.
     */
    setPlotSelection(plotId: string, featureIds: number[], mapId?: MapId): void {
        this._plotRegistry.get(plotId)?.setSelection(featureIds);
        // A layer is lit at its own positions of the selected rows.
        const rows = this._plotRows.get(plotId) ?? [];
        for (const layer of this._plotLinks.get(plotId) ?? []) {
            if (isOnMap(layer, mapId)) layer.map.setHighlightedIds(layer.layerId, translateIds(featureIds, rows, layer.rows));
        }
    }

    /**
     * Applies a selection made on `layers`, by their positions `featureIds`, to every plot linked to one of them, at the
     * plot's own positions of the selected rows.
     */
    private _selectInLinkedPlots(layers: DrawnLayer[], featureIds: number[]): void {
        for (const [plotId, linked] of this._plotLinks) {
            const selected = linked.filter((layer) => layers.includes(layer));
            if (selected.length === 0) continue;
            const rows = this._plotRows.get(plotId) ?? [];
            const ids = new Set(selected.flatMap((layer) => translateIds(featureIds, layer.rows, rows)));
            this._plotRegistry.get(plotId)?.setSelection([...ids]);
        }
    }

    /** Wires each entry of `links` between a plot and a layer of a map, both now drawn. */
    private _wireLinks(spec: UrbanSpec): void {
        const maps = asList(spec.map);
        const plots = asList(spec.plot);
        for (const link of spec.links ?? []) {
            const plotSpec = plots.find((p) => plotKey(p) === link.source);
            const plot = this._plotRegistry.get(link.source);
            if (!plotSpec || !plot)
                throw new Error(`Link source "${link.source}" is not the id (or the dataRef) of a plot of this specification.`);

            const mapIndex = maps.findIndex((m) => m.id === link.target);
            const map = this._maps[mapIndex];
            if (mapIndex < 0 || !map)
                throw new Error(`Link target "${link.target}" is not the id of a map of this specification.`);

            const layerRef = maps[mapIndex].layerRefs.find((l) =>
                link.layer !== undefined ? layerIdOf(l) === link.layer : l.dataRef === plotSpec.dataRef);
            if (!layerRef)
                throw new Error(link.layer !== undefined
                    ? `Link from "${link.source}": map "${link.target}" has no layer "${link.layer}".`
                    : `Link from "${link.source}": map "${link.target}" draws no layer of the table "${plotSpec.dataRef}"; name the layer.`);

            // The link names its map, so it is that map's layer that it links, though other maps draw the table too.
            const layer = this._layers.find((drawn) => drawn.mapIndex === mapIndex && drawn.layerId === layerIdOf(layerRef));
            if (!layer) continue;
            linkPlotToLayer(plot, this._plotRows.get(link.source) ?? [], (plotSpec.events ?? []) as unknown as PlotEvent[], layer);
            addPlotLink(this._plotLinks, link.source, layer);
        }
    }

    private _rewireInteractions(spec: UrbanSpec): void {
        for (const cleanup of this._fwdCleanups) cleanup();
        this._fwdCleanups = [];

        // Wire every map to the grammar bus once, though several maps can draw one table, and name the map in each
        // pick. autk-map names the picked layer by its id in the map, which is its title, else its dataRef.
        const maps = asList(spec.map);
        this._maps.forEach((map, index) => {
            const mapId = mapIdOf(maps[index], index);
            const handler = ({ layerId, selection }: MapEventData) => {
                this.interactions.emit('map:picking', { mapId, layerId, selection });
            };
            map.events.on(MapEvent.PICKING, handler);
            this._fwdCleanups.push(() => map.events.off(MapEvent.PICKING, handler));
        });

        // Wire each plot → grammar bus (all four event types)
        for (const [plotId, plot] of this._plotRegistry) {
            for (const ev of [PlotEvent.CLICK, PlotEvent.BRUSH, PlotEvent.BRUSH_X, PlotEvent.BRUSH_Y] as const) {
                const handler = ({ selection }: PlotEventData) => {
                    this.interactions.emit('plot:selection', {
                        plotId,
                        event: ev as GrammarPlotSelectionEvent['event'],
                        selection,
                    });
                };
                plot.events.on(ev, handler);
                this._fwdCleanups.push(() => plot.events.off(ev, handler));
            }
        }
    }
}
