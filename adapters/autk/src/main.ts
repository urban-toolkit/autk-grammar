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
import { createPlotAdapter } from "./adapters/plot";
import { createComputeAdapter } from "./adapters/compute";
import { Targets, MapRegistry, PlotRegistry, PlotMapLinks, GeoJsonCache, ComputeCache, GrammarEventEmitter } from "./types";
import type { GrammarPlotSelectionEvent } from "./types";

export class AutkGrammar {
    private dataAdapter?: DataAdapter;
    private mapAdapter?: MapAdapter;
    private plotAdapter?: PlotAdapter;
    private computeAdapter?: ComputeAdapter;
    private grammarEngine?: IEngine;
    private _computeCache: ComputeCache = new Map();
    private _data: Record<string, Promise<FeatureCollection>> = {};
    private _mapRegistry: MapRegistry = new Map();
    private _plotRegistry: PlotRegistry = new Map();
    private _fwdCleanups: Array<() => void> = [];
    private _plotMapLinks: PlotMapLinks = new Map();

    readonly interactions = new GrammarEventEmitter();

    constructor(targets?: Targets) {
        const cache: GeoJsonCache = new Map();
        this.dataAdapter = createDataAdapter(targets, cache);
        this.mapAdapter = createMapAdapter(targets, this._mapRegistry, this._computeCache);
        this.plotAdapter = createPlotAdapter(targets, this._mapRegistry, this._plotRegistry, this._plotMapLinks, cache);
        this.computeAdapter = createComputeAdapter(this._computeCache);
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

    async run(spec: UrbanSpec) {
        if(!this.dataAdapter)
            throw new Error('Database adapter not initialized. Please call the constructor first.');

        if(!this.mapAdapter)
            throw new Error('Map engine not initialized. Please call the constructor first.');

        if(!this.plotAdapter)
            throw new Error('Plot adapter not initialized. Please call the constructor first.');

        if(!this.computeAdapter)
            throw new Error('Compute adapter not initialized. Please call the constructor first.');

        this._mapRegistry.clear();
        this._plotRegistry.clear();
        this._plotMapLinks.clear();

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
        this._rewireInteractions();

        const db = this.grammarEngine.context as AutkDb | undefined;
        if (!db) {
            console.warn('Grammar engine produced no data context.');
            this._data = {};
            return;
        }

        const dataObj: Record<string, Promise<FeatureCollection>> = {};
        for (const table of db.getLayerTables()) {
            Object.defineProperty(dataObj, table.name, {
                get: () => {
                    const computed = this._computeCache.get(table.name);
                    return computed ? Promise.resolve(computed) : db.getLayer(table.name);
                },
                enumerable: true,
                configurable: true,
            });
        }
        this._data = dataObj;
    }

    /**
     * Highlights features on the map layer identified by `layerId`.
     * If that layer is linked to a plot via `mapRef`, the plot selection is updated too.
     */
    highlightOnMap(layerId: string, featureIds: number[]): void {
        this._mapRegistry.get(layerId)?.setHighlightedIds(layerId, featureIds);
        for (const [plotId, mapRef] of this._plotMapLinks) {
            if (mapRef === layerId) this._plotRegistry.get(plotId)?.setSelection(featureIds);
        }
    }

    /**
     * Clears highlighted features on the map layer identified by `layerId`.
     * If that layer is linked to a plot via `mapRef`, the plot selection is cleared too.
     */
    clearHighlightOnMap(layerId: string): void {
        this._mapRegistry.get(layerId)?.clearHighlightedIds(layerId);
        for (const [plotId, mapRef] of this._plotMapLinks) {
            if (mapRef === layerId) this._plotRegistry.get(plotId)?.setSelection([]);
        }
    }

    /**
     * Clears the selection on the plot identified by `plotId` (its dataRef).
     * If that plot is linked to a map via `mapRef`, the map highlight is cleared too.
     */
    clearHighlightOnPlot(plotId: string): void {
        this._plotRegistry.get(plotId)?.setSelection([]);
        const mapRef = this._plotMapLinks.get(plotId);
        if (mapRef) this._mapRegistry.get(mapRef)?.clearHighlightedIds(mapRef);
    }

    /**
     * Applies a selection to the plot identified by `plotId` (its dataRef).
     * If that plot is linked to a map via `mapRef`, the map highlight is updated too.
     */
    setPlotSelection(plotId: string, featureIds: number[]): void {
        this._plotRegistry.get(plotId)?.setSelection(featureIds);
        const mapRef = this._plotMapLinks.get(plotId);
        if (mapRef) this._mapRegistry.get(mapRef)?.setHighlightedIds(mapRef, featureIds);
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
