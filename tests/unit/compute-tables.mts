// Unit tests for the compute passes that run on the CPU through autk-core, as the compute adapter runs them. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
import { TriangulatorBuildingWithWindows } from '@urban-toolkit/autk-core';
import { windowsTable } from '../../adapters/autk/src/compute-tables.ts';

const rect = (x: number, y: number, width: number, height: number): Polygon => ({
    type: 'Polygon',
    coordinates: [[[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]]],
});

// windows: one point a window, as autk-core places a render pass's building-windows viewpoints.
{
    // A building 30 by 12 units and 10 high, and one 12 by 12 with no height, which autk-core takes as 20 high.
    const buildings: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', properties: { height: 10 }, geometry: rect(0, 0, 30, 12) },
            { type: 'Feature', properties: {}, geometry: rect(100, 0, 12, 12) },
        ],
    };
    const windows = windowsTable(buildings, 2);
    assert.deepEqual(windows, TriangulatorBuildingWithWindows.buildWindowLayout(buildings, 2).collection);
    // About 6 units apart along each facade: 5 on a 30-unit side and 2 on a 12-unit one, 14 a floor on the first building
    // and 8 on the second, on each of 2 floors.
    const of = (building: number) => windows.features.filter((feature) => feature.properties?.sourceFeatureIndex === building);
    assert.equal(of(0).length, 28);
    assert.equal(of(1).length, 16);
    // At the middle of each floor's height: 2.5 and 7.5 on the 10-unit building, 5 and 15 on the 20-unit one.
    const heights = (features: Feature[]) =>
        [...new Set(features.map((feature) => (feature.geometry as Point).coordinates[2]))].sort((a, b) => a - b);
    assert.deepEqual(heights(of(0)), [2.5, 7.5]);
    assert.deepEqual(heights(of(1)), [5, 15]);
    assert.deepEqual([...new Set(of(0).map((feature) => feature.properties?.floorIndex))], [0, 1]);
    // Each a point, its id the window's, no two alike.
    const ids = windows.features.map((feature) => feature.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(windows.features.every((feature) => feature.geometry.type === 'Point' && feature.id === feature.properties?.windowId));
    // floors is rounded down, and at least one row is placed.
    assert.equal(windowsTable(buildings, 2.7).features.length, 44);
    assert.equal(windowsTable(buildings, 0).features.length, 22);
    // A table of points has no facades: autk-core refuses it, and the adapter names the pass with its reason.
    const points: FeatureCollection = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }],
    };
    assert.throws(() => windowsTable(points, 1), /unsupported part geometry Point/);
}

console.log('compute-tables: all cases passed');
