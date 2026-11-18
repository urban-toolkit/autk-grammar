import type { MapSpec } from '@urban-toolkit/the-urban-grammar';
import type { AutkMap } from '@urban-toolkit/autk-map';
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
}

/** Every layer the maps of the last run draw, one entry per layer of each map: the maps in order, layers bottom first. */
export type DrawnLayers = DrawnLayer[];

/** A map's {@link MapId}: its `id`, else its index in the spec's `map` list. */
export function mapIdOf(spec: MapSpec | undefined, index: number): MapId {
    return spec?.id ?? index;
}
