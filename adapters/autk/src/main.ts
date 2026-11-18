import { DataAdapter, MapAdapter, PlotAdapter, ComputeAdapter, IEngine, UrbanSpec, createEngine } from "@urban-toolkit/the-urban-grammar";
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
import { createComputeAdapter } from "./adapters/compute";
import { Targets, MapRegistry, MapLayerIds, PlotRegistry, PlotMapLinks, GeoJsonCache, ComputeCache, ComputeLayerTypes, GrammarEventEmitter } from "./types";
import type { GrammarMapLayer, GrammarPlotSelectionEvent } from "./types";

function asList<T>(value: T[] | T | undefined): T[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** An id names one view: no two maps or plots may share one, and an id is never empty. */
function checkViewIds(spec: UrbanSpec): void {
    const seen = new Set<string>();
    for (const view of [...asList(spec.map), ...asList(spec.plot)]) {
        if (view.id === undefined) continue;
        if (view.id === '') throw new Error('A map or plot has an empty id.');
        if (seen.has(view.id)) throw new Error(`Two maps or plots have the id "${view.id}"; an id names one view.`);
        seen.add(view.id);
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
    private _mapRegistry: MapRegistry = new Map();
    private _mapLayerIds: MapLayerIds = new Map();
    private _maps: AutkMap[] = [];
    private _plotRegistry: PlotRegistry = new Map();
    private _fwdCleanups: Array<() => void> = [];
    private _plotMapLinks: PlotMapLinks = new Map();

    readonly interactions = new GrammarEventEmitter();

    constructor(targets?: Targets) {
        const cache: GeoJsonCache = new Map();
        this.dataAdapter = createDataAdapter(targets, cache);
        this.mapAdapter = createMapAdapter(targets, this._mapRegistry, this._computeCache, this._maps, this._mapLayerIds, this._computeTypes);
        this.plotAdapter = createPlotAdapter(targets, this._mapRegistry, this._plotRegistry, this._plotMapLinks, cache, this._mapLayerIds, this._computeCache);
        this.computeAdapter = createComputeAdapter(this._computeCache, this._computeTypes);
    }

    /**
     * The coordinate reference system used internally by the autk workspace.
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
     * The layer a map of the last {@link run} draws for a table, found by the table's name (a layer's `dataRef`):
     * the map that draws it, and the layer's id in that map, which is its `title`, else its `dataRef`.
     * `undefined` when no map draws the table. When several layers draw it, the last one.
     *
     * @example
     * const layer = grammar.mapLayer('buildings');
     * layer?.map.updateRenderInfo(layer.layerId, { opacity: 0.5 });
     */
    mapLayer(dataRef: string): GrammarMapLayer | undefined {
        const map = this._mapRegistry.get(dataRef);
        return map ? { map, layerId: this._mapLayerIds.get(dataRef) ?? dataRef } : undefined;
    }

    /**
     * Releases what the last run created: every map (its GPU device and event handlers) and the grammar's own
     * registries, caches and event forwarding. Call it before the page or the container goes away; `run` calls it
     * before it starts, so running a new spec on the same instance does not leak the maps of the old one.
     */
    destroy(): void {
        for (const cleanup of this._fwdCleanups) cleanup();
        this._fwdCleanups = [];
        for (const map of this._maps) map.destroy();
        this._maps.length = 0;
        this._mapRegistry.clear();
        this._mapLayerIds.clear();
        this._plotRegistry.clear();
        this._plotMapLinks.clear();
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
        this._wireLinks(spec);
        this._rewireInteractions();

        const db = this.grammarEngine.context as AutkDb | undefined;
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
     * Highlights features on the map layer that draws the table `dataRef` (see {@link mapLayer}).
     * If that layer is linked to a plot via `mapRef`, the plot selection is updated too.
     */
    highlightOnMap(dataRef: string, featureIds: number[]): void {
        const layer = this.mapLayer(dataRef);
        layer?.map.setHighlightedIds(layer.layerId, featureIds);
        for (const [plotId, mapRef] of this._plotMapLinks) {
            if (mapRef === dataRef) this._plotRegistry.get(plotId)?.setSelection(featureIds);
        }
    }

    /**
     * Clears highlighted features on the map layer that draws the table `dataRef` (see {@link mapLayer}).
     * If that layer is linked to a plot via `mapRef`, the plot selection is cleared too.
     */
    clearHighlightOnMap(dataRef: string): void {
        const layer = this.mapLayer(dataRef);
        layer?.map.clearHighlightedIds(layer.layerId);
        for (const [plotId, mapRef] of this._plotMapLinks) {
            if (mapRef === dataRef) this._plotRegistry.get(plotId)?.setSelection([]);
        }
    }

    /**
     * Clears the selection on the plot identified by `plotId` (its dataRef).
     * If that plot is linked to a map via `mapRef`, the map highlight is cleared too.
     */
    clearHighlightOnPlot(plotId: string): void {
        this._plotRegistry.get(plotId)?.setSelection([]);
        const mapRef = this._plotMapLinks.get(plotId);
        const layer = mapRef ? this.mapLayer(mapRef) : undefined;
        layer?.map.clearHighlightedIds(layer.layerId);
    }

    /**
     * Applies a selection to the plot identified by `plotId` (its dataRef).
     * If that plot is linked to a map via `mapRef`, the map highlight is updated too.
     */
    setPlotSelection(plotId: string, featureIds: number[]): void {
        this._plotRegistry.get(plotId)?.setSelection(featureIds);
        const mapRef = this._plotMapLinks.get(plotId);
        const layer = mapRef ? this.mapLayer(mapRef) : undefined;
        layer?.map.setHighlightedIds(layer.layerId, featureIds);
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

            linkPlotToLayer(plot, (plotSpec.events ?? []) as unknown as PlotEvent[], map, layerIdOf(layerRef));
            this._plotMapLinks.set(link.source, layerRef.dataRef);
        }
    }

    private _rewireInteractions(): void {
        for (const cleanup of this._fwdCleanups) cleanup();
        this._fwdCleanups = [];

        // Wire each unique map → grammar bus
        // Multiple layerRefs can share one AutkMap instance; deduplicate to avoid double-subscription
        const seenMaps = new Set<AutkMap>();
        for (const [layerId, map] of this._mapRegistry) {
            if (seenMaps.has(map)) continue;
            seenMaps.add(map);
            const handler = ({ selection }: MapEventData) => {
                this.interactions.emit('map:picking', { layerId, selection });
            };
            map.events.on(MapEvent.PICKING, handler);
            this._fwdCleanups.push(() => map.events.off(MapEvent.PICKING, handler));
        }

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
