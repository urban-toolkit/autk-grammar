import type { MapSpec } from '@urban-toolkit/the-urban-grammar';
import type { AutkDb } from '@urban-toolkit/autk-db';
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

/**
 * The key of a table's export in {@link LayerExports}: its `tableKey`, with ` osm-elements` added for the export of one
 * feature per OpenStreetMap element, which a layer or a plot with `osmElements` reads. A table's name holds no space, so
 * the two never meet.
 */
export function exportKey(key: string, osmElements?: boolean): string {
    return osmElements === true ? `${key} osm-elements` : key;
}

/** autk-db's options for a table's export: one feature per OpenStreetMap element with `osmElements`, else none. */
export function exportOptions(osmElements?: boolean): { osmElements: true } | undefined {
    return osmElements === true ? { osmElements: true } : undefined;
}

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

/**
 * autk-db's export of the OpenStreetMap layer table `name` one feature per element, which a map layer or a plot with
 * `osmElements` reads when a compute pass changed that table in place, or `undefined` when autk-db gives no elements.
 * Maps and plots read a pass's result from the compute adapter's cache first, while autk-db keeps the elements the table
 * was built from, which the pass leaves as they were. autk-db exports an OSM table row by row once an update cleared
 * its element records, an in-place `writeBack` among them, and holds no table only a pass wrote: such a table is read
 * as without `osmElements`, the pass's rows.
 */
export async function osmElementsOf(db: AutkDb, name: string, key: string, exports?: LayerExports): Promise<FeatureCollection | undefined> {
    if (db.getTablesMetadata().find((table) => table.name === name)?.source !== 'osm') return undefined;
    const collection = await exportOf(exports, exportKey(key, true), () => db.getLayer(name, exportOptions(true)));
    // An element carries its osm_id, which no row of autk-db's export row by row does.
    const features = collection.features ?? [];
    return features.length > 0 && features.every((feature) => feature?.properties != null && 'osm_id' in feature.properties) ? collection : undefined;
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
