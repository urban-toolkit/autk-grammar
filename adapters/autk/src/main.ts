import { DataAdapter, MapAdapter, PlotAdapter, ComputeAdapter, IEngine, UrbanSpec, createEngine } from "@urban-toolkit/the-urban-grammar";
import { AutkDb, DEFAULT_WORKSPACE_COORDINATE_FORMAT } from "@urban-toolkit/autk-db";
import { FeatureCollection } from "geojson";
import { createDataAdapter } from "./adapters/data";
import { createMapAdapter } from "./adapters/map";
import { createPlotAdapter } from "./adapters/plot";
import { createComputeAdapter } from "./adapters/compute";
import { Targets, MapRegistry, GeoJsonCache, ComputeCache } from "./types";

export class AutkGrammar {
    private dataAdapter?: DataAdapter;
    private mapAdapter?: MapAdapter;
    private plotAdapter?: PlotAdapter;
    private computeAdapter?: ComputeAdapter;
    private grammarEngine?: IEngine;
    private _computeCache: ComputeCache = new Map();
    private _data: Record<string, Promise<FeatureCollection>> = {};

    constructor(targets?: Targets) {
        const registry: MapRegistry = new Map();
        const cache: GeoJsonCache = new Map();
        this.dataAdapter = createDataAdapter(targets, cache);
        this.mapAdapter = createMapAdapter(targets, registry, this._computeCache);
        this.plotAdapter = createPlotAdapter(targets, registry, cache);
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
}