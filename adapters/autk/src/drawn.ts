import type { MapSpec } from '@urban-toolkit/the-urban-grammar';
import type { AutkMap } from '@urban-toolkit/autk-map';
import type { FeatureCollection } from 'geojson';
import type { MapId } from './types';

/** A layer a map of the last run draws, as the map adapter registers it once the map's layers are loaded. */
export interface DrawnLayer {
    /** The map that draws it. */
    map: AutkMap;
    /** The map's index in the spec's `map` list. */
    mapIndex: number;
    /** The map's {@link MapId}: its `id`, else its index. */
    mapId: MapId;
    /** The layer's id in the map: its `title`, else its `dataRef`. */
    layerId: string;
    /** The table the layer draws. */
    dataRef: string;
    /** The key of the row the layer draws at each of its positions (see `rowKeys`); empty for a raster. */
    rows: readonly string[];
}

/** Every layer the maps of the last run draw, one entry per layer of each map: the maps in order, layers bottom first. */
export type DrawnLayers = DrawnLayer[];

/** The layers each plot is linked to, by a link or its `mapRef`, keyed by the plot's `id`, else its `dataRef`. */
export type PlotLinks = Map<string, DrawnLayer[]>;

/** The key of the row each plot draws at each of its positions (see `rowKeys`), keyed by the plot's `id`, else its `dataRef`. */
export type PlotRows = Map<string, readonly string[]>;

/** The export of each table a map or a plot of the last run read, by its `tableKey`. */
export type LayerExports = Map<string, Promise<FeatureCollection>>;

/** A table's export, taken once a run, so the maps and the plots of one table draw the same rows. */
export function exportOf(exports: LayerExports | undefined, key: string, load: () => Promise<FeatureCollection>): Promise<FeatureCollection> {
    if (!exports) return load();
    let collection = exports.get(key);
    if (!collection) {
        collection = load();
        exports.set(key, collection);
    }
    return collection;
}

/** A map's {@link MapId}: its `id`, else its index in the spec's `map` list, which `arrangeViews` gives its pane as its `key`. */
export function mapIdOf(spec: MapSpec | undefined, index: number): MapId {
    return spec?.id ?? index;
}

/**
 * Whether a layer is on the map `mapId` names: a string names a map by its `id`, a number by its index. Without one,
 * every layer is.
 */
export function isOnMap(layer: DrawnLayer, mapId?: MapId): boolean {
    if (mapId === undefined) return true;
    return typeof mapId === 'number' ? layer.mapIndex === mapId : layer.mapId === mapId;
}

/** Records that a plot is linked to a layer, once. */
export function addPlotLink(links: PlotLinks | undefined, plotKey: string, layer: DrawnLayer): void {
    const linked = links?.get(plotKey) ?? [];
    if (!linked.includes(layer)) links?.set(plotKey, [...linked, layer]);
}
