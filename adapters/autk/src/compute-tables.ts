import type { FeatureCollection } from 'geojson';
import { TriangulatorBuildingWithWindows } from '@urban-toolkit/autk-core';

/**
 * The windows of the buildings of `buildings`, one point a window, as autk-core places a render pass's
 * `building-windows` viewpoints (`TriangulatorBuildingWithWindows.buildWindowLayout`): `floors` rows on each facade,
 * spread evenly up the building's height, about 6 workspace units apart along it. Each point is a feature whose id is
 * the window's, at the middle of the window, with the window's building, facade, floor and size in its properties.
 * autk-core rounds `floors` down and places at least one row; a building without a height is taken as 20 units high.
 */
export function windowsTable(buildings: FeatureCollection, floors: number): FeatureCollection {
    return TriangulatorBuildingWithWindows.buildWindowLayout(buildings, floors).collection;
}
