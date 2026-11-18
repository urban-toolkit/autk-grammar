import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
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

export type MapRegistry = Map<string, AutkMap>;
export type MapLayerIds = Map<string, string>; // dataRef → id of the layer that draws it in the map the MapRegistry holds for it
export type PlotRegistry = Map<string, AutkPlot>;
export type PlotMapLinks = Map<string, string>; // plotId (dataRef) → mapRef (dataRef of a map layer)

/** A layer a map of the last run draws, as `AutkGrammar.mapLayer` finds it by its table's name. */
export interface GrammarMapLayer {
    /** The map that draws the layer. */
    map: AutkMap;
    /** The layer's id in that map: its `title`, else its `dataRef`. */
    layerId: string;
}
export type GeoJsonCache = Map<string, FeatureCollection>;
export type ComputeCache = Map<string, FeatureCollection>;
/** How the map draws a table a compute pass wrote under `outputTableName`, which the database does not know. */
export type ComputeLayerTypes = Map<string, LayerType>;

export type AutkGrammarSpec = UrbanSpec;

// Grammar-level interaction payloads: no autk internals leak through the public API
export interface GrammarPickingEvent {
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

