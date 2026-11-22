import type { ComputeAdapter, DataAdapter, UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import type { AutkMap } from '@urban-toolkit/autk-map';
import type { AutkPlot } from '@urban-toolkit/autk-plot';
import type { LayerType } from '@urban-toolkit/the-urban-grammar';
import type { FeatureCollection } from 'geojson';

/** The elements of the page `AutkGrammar` draws in, by id. */
export type Targets = {
    /** Not read by the adapter. */
    compute?: string,
    /** Id of an element that lists the loaded tables after each data source. */
    db?: string,
    /** Id of the canvas a map draws on, or a list of ids, one canvas per entry of `map`, in order. */
    map?: string[] | string,
    /**
     * Id of the element the plots draw in, or a list of ids, one element per entry of `plot`, in order. With one id,
     * every plot draws in that element.
     */
    plot?: string[] | string
}

/**
 * What a host hands `AutkGrammar` besides its targets: its own adapters around the grammar's, which every run of the
 * grammar calls instead. Each function is called once, as the grammar is made, with the grammar's own adapter, already
 * wired to the grammar's caches, so maps and plots read what the host's adapter runs. A grammar made without them runs
 * as before.
 */
export interface AutkGrammarOptions {
    /**
     * Returns the compute adapter every pass of every run goes through: its `resolveCompute(context, pass)` runs one
     * entry of the spec's `compute` on the run's database, and returns it. A host that checks each pass, in GPU error
     * scopes for example, calls the given adapter's `resolveCompute` inside its check and returns what that returns.
     */
    wrapComputeAdapter?: (adapter: ComputeAdapter) => ComputeAdapter;
    /**
     * Returns the data adapter the spec's `workspaces` and every source of every run go through, those before compute
     * and those after. It keeps `resolveWorkspaces`: `{ ...adapter, resolveSource }` keeps the grammar's. Each call takes
     * the run's database, undefined until the workspaces or the first source make one, and returns the database the run
     * goes on with: each run starts with none. So a host that loads a kind of source of its own loads it there and hands
     * every other source to the given adapter, and a host that keeps the run's database in hand, to read its tables or
     * to end it, hands the given adapter a new database of its own where it is given none, one for each run:
     * `adapter.resolveSource(context ?? await newDb(), source)`, where `newDb` makes an `AutkDb` and keeps it. One
     * database made once and handed to every run would hold the last run's tables, extent and crop, and autk-db refuses
     * an OpenStreetMap source once the workspace holds another table.
     *
     * The adapter it returns needs `resolveSource` and `resolveWorkspaces`, which a run calls and the grammar checks for
     * as it is made. Any other call `DataAdapter` has is optional in it, as in `DataAdapter`, so a call a later release
     * adds there asks nothing new of a host's adapter.
     */
    wrapDataAdapter?: (adapter: Required<DataAdapter>) => DataAdapter & Required<Pick<DataAdapter, 'resolveSource' | 'resolveWorkspaces'>>;
}

/**
 * How the grammar names a map of the spec: its `id`, else its index in the spec's `map` list (0 for a single map).
 * `map:picking` events name the map by it, and the calls that take a `mapId` (`mapLayers`, `mapLayer`,
 * `highlightOnMap`, `clearHighlightOnMap`, `setPlotSelection`, `clearHighlightOnPlot`) address one map with it: a
 * string names a map by its `id`, a number by its index.
 */
export type MapId = string | number;

export type PlotRegistry = Map<string, AutkPlot>;

/** A layer a map of the last run draws, as `AutkGrammar.mapLayer` finds it by its table's name. */
export interface GrammarMapLayer {
    /** The map that draws the layer. */
    map: AutkMap;
    /** The layer's id in that map: its `title`, else its `dataRef`. */
    layerId: string;
    /**
     * What the run handed autk-map for the layer: the features of its table that have a geometry, in the table's order,
     * as the run read them (a pass's result, an OpenStreetMap table's elements, or autk-db's export); for a raster, its
     * one feature. It is the collection itself, not a copy: read it, and change nothing in it.
     */
    readonly collection: FeatureCollection;
}
export type GeoJsonCache = Map<string, FeatureCollection>;
export type ComputeCache = Map<string, FeatureCollection>;
/** How the map draws a table a compute pass wrote under `outputTableName`, which the database does not know. */
export type ComputeLayerTypes = Map<string, LayerType>;

export type AutkGrammarSpec = UrbanSpec;

// Grammar-level interaction payloads: no autk internals leak through the public API
export interface GrammarPickingEvent {
    /** The map the pick was made on, by its {@link MapId}: its `id`, else its index in the spec's `map` list. */
    mapId: MapId;
    /** The picked layer's id in its map: its `title`, else its `dataRef`. */
    layerId: string;
    selection: number[];
}

export interface GrammarPlotSelectionEvent {
    /** The plot's `id`, else its `dataRef`. */
    plotId: string;
    event: 'click' | 'brush' | 'brushX' | 'brushY';
    selection: number[];
}

export type GrammarEventRecord = {
    'map:picking':    GrammarPickingEvent;
    'plot:selection': GrammarPlotSelectionEvent;
};

// Self-contained typed emitter: it does not import from autk packages
export class GrammarEventEmitter {
    private _listeners: Map<string, Set<(p: unknown) => void>> = new Map();

    on<K extends keyof GrammarEventRecord>(
        event: K,
        listener: (payload: GrammarEventRecord[K]) => void
    ): () => void {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        const bucket = this._listeners.get(event)!;
        bucket.add(listener as (p: unknown) => void);
        return () => bucket.delete(listener as (p: unknown) => void);
    }

    /** @internal */
    emit<K extends keyof GrammarEventRecord>(event: K, payload: GrammarEventRecord[K]): void {
        this._listeners.get(event)?.forEach(l => l(payload));
    }
}

