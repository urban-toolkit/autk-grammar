import type { Geometry, FeatureCollection } from 'geojson';

export type ViewState = {
    longitude: number;
    latitude: number;
    zoom: number;
};

function collectCoords(geometry: Geometry): [number, number][] {
    switch (geometry.type) {
        case 'Point':
            return [geometry.coordinates as [number, number]];
        case 'MultiPoint':
        case 'LineString':
            return geometry.coordinates as [number, number][];
        case 'MultiLineString':
        case 'Polygon':
            return (geometry.coordinates as [number, number][][]).flat();
        case 'MultiPolygon':
            return (geometry.coordinates as [number, number][][][]).flat(2);
        case 'GeometryCollection':
            return geometry.geometries.flatMap(collectCoords);
        default:
            return [];
    }
}

export function computeViewState(collections: FeatureCollection[]): ViewState {
    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;
    let count = 0;

    for (const fc of collections) {
        for (const feature of fc.features) {
            if (!feature.geometry) continue;
            for (const [lon, lat] of collectCoords(feature.geometry)) {
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                count++;
            }
        }
    }

    if (count === 0) return { longitude: 0, latitude: 0, zoom: 2 };

    const longitude = (minLon + maxLon) / 2;
    const latitude = (minLat + maxLat) / 2;
    const maxSpan = Math.max(maxLon - minLon, maxLat - minLat);
    const zoom = maxSpan === 0 ? 14 : Math.max(1, Math.min(18, Math.floor(8 - Math.log2(maxSpan))));

    return { longitude, latitude, zoom };
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
        if (acc == null || typeof acc !== 'object') return undefined;
        return (acc as Record<string, unknown>)[key];
    }, obj);
}

export function computePercentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
}
