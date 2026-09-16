import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import type { AutkMap } from '@urban-toolkit/autk-map';
import type { AutkPlot } from '@urban-toolkit/autk-plot';
import type { FeatureCollection } from 'geojson';

export type Targets = {
    compute?: string,
    db?: string,
    map?: string[] | string,
    plot?: string
}

export type MapRegistry = Map<string, AutkMap>;
export type PlotRegistry = Map<string, AutkPlot>;
export type PlotMapLinks = Map<string, string>; // plotId (dataRef) → mapRef (layerId)
export type GeoJsonCache = Map<string, FeatureCollection>;
export type ComputeCache = Map<string, FeatureCollection>;

export type AutkGrammarSpec = UrbanSpec;

// Grammar-level interaction payloads — no autk internals leak through the public API
export interface GrammarPickingEvent {
    layerId: string;
    selection: number[];
}

export interface GrammarPlotSelectionEvent {
    plotId: string;
    event: 'click' | 'brush' | 'brushX' | 'brushY';
    selection: number[];
}

export type GrammarEventRecord = {
    'map:picking':    GrammarPickingEvent;
    'plot:selection': GrammarPlotSelectionEvent;
};

// Self-contained typed emitter — does not import from autk packages
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

