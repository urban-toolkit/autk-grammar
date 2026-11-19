import type { FeatureCollection, Geometry } from 'geojson';
import { TriangulatorBuildingWithWindows, computeIntersectingClusterIds } from '@urban-toolkit/autk-core';

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

/** Whether a coordinate array holds at least one position. */
function hasPosition(coordinates: unknown): boolean {
    return Array.isArray(coordinates) && (typeof coordinates[0] === 'number' || coordinates.some(hasPosition));
}

/** Whether a geometry has any position: a null one has none, and nor does an empty one, which a map draws as nothing. */
function hasShape(geometry: Geometry | null | undefined): boolean {
    if (!geometry) return false;
    if (geometry.type === 'GeometryCollection') return geometry.geometries.some(hasShape);
    return hasPosition(geometry.coordinates);
}

/**
 * `table` with each row's cluster id written to `properties.compute.<column>`, through autk-core's
 * `computeIntersectingClusterIds`: rows whose geometries intersect or touch, directly or through other rows, share a
 * cluster. The ids are whole numbers from 0, the first row's cluster being 0 and each other cluster taking the next
 * number in the order of its first row. A row without a geometry, or with an empty one, as a GeoJSON source's row
 * without a geometry is loaded, is in no cluster: its id is `null`. The rows are copies; `table` is left as it is.
 */
export function clustersTable(table: FeatureCollection, column: string): FeatureCollection {
    // Each row is named by its position, so rows that share a feature id stay apart. autk-core would put an empty
    // geometry in a cluster of its own, so only a geometry with a position is handed over.
    const clusters = computeIntersectingClusterIds(
        table.features.map((feature, row) => ({ id: row, geometry: hasShape(feature.geometry) ? feature.geometry : null })),
    );
    return {
        ...table,
        features: table.features.map((feature, row) => {
            const properties: Record<string, unknown> = { ...(feature.properties ?? {}) };
            properties.compute = { ...(properties.compute as Record<string, unknown> | undefined), [column]: clusters.get(String(row)) ?? null };
            return { ...feature, properties };
        }),
    };
}
