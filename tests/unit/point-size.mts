// Unit tests for a points layer's pointSize, meters on the ground, as autk-map's radius in planar units. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import { checkPointSize, planarPointSize, planarUnitsPerMeter } from '../../adapters/autk/src/point-size.ts';

// The planar y of a latitude in degrees: World Mercator (EPSG:3395) on the WGS84 ellipsoid, as autk-db projects
// degrees, and Web Mercator (EPSG:3857) on its sphere.
const a = 6378137;
const e = 0.0818191908426215;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
function worldMercatorY(lat: number): number {
    const s = e * Math.sin(radians(lat));
    return a * Math.log(Math.tan(Math.PI / 4 + radians(lat) / 2) * ((1 - s) / (1 + s)) ** (e / 2));
}
const webMercatorY = (lat: number) => a * Math.log(Math.tan(Math.PI / 4 + radians(lat) / 2));

/** Asserts that `actual` is within `tolerance` of `expected`. */
function near(actual: number | undefined, expected: number, tolerance: number) {
    assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test('a meter at 41.7 degrees north spans about 1.34 World Mercator units, sec φ times sqrt(1 - e² sin² φ)', () => {
    const k = planarUnitsPerMeter('EPSG:3395', worldMercatorY(41.7));
    const s = e * Math.sin(radians(41.7));
    near(k, Math.sqrt(1 - s * s) / Math.cos(radians(41.7)), 1e-9);
    near(k, 1.3374, 1e-4);
    near(planarUnitsPerMeter('epsg:3395', worldMercatorY(41.7)), k, 1e-12);
});

test('a meter spans one World Mercator unit at the equator', () => {
    near(planarUnitsPerMeter('EPSG:3395', 0), 1, 1e-12);
    near(planarUnitsPerMeter('EPSG:3395', worldMercatorY(0.001)), 1, 1e-9);
});

test('a meter spans sec φ Web Mercator units, on the sphere', () => {
    near(planarUnitsPerMeter('EPSG:3857', webMercatorY(41.7)), 1 / Math.cos(radians(41.7)), 1e-9);
    near(planarUnitsPerMeter('EPSG:3857', 0), 1, 1e-12);
});

test('a workspace CRS that is not Mercator takes a meter as one planar unit', () => {
    for (const crs of ['EPSG:32616', 'EPSG:31983', 'EPSG:2154'])
        assert.equal(planarUnitsPerMeter(crs, 4_640_000), 1, crs);
});

test("autk-map's default radius of 64 planar units is about 48 m on the ground at Chicago", () => {
    near(64 / planarUnitsPerMeter('EPSG:3395', worldMercatorY(41.88)), 47.7, 0.05);
});

test('a points layer is sized at the middle of the planar y of its extent', () => {
    // From 41.6 to 41.8 degrees north: the middle of the planar y is within a hair of 41.7.
    const extent = [0, worldMercatorY(41.6), 10, worldMercatorY(41.8)];
    const size = planarPointSize(2, 'points', 'EPSG:3395', () => extent);
    assert.equal(size, 2 * planarUnitsPerMeter('EPSG:3395', (extent[1] + extent[3]) / 2));
    near(size, 2 * 1.3374, 1e-3);
    // 2 m at Chicago, for GPS fixes a meter or two apart; 1 m at the equator; meters in a projected CRS.
    near(planarPointSize(2, 'points', 'EPSG:3395', () => [0, worldMercatorY(41.88), 0, worldMercatorY(41.88)]), 2.682, 1e-3);
    near(planarPointSize(1, 'points', 'EPSG:3395', () => [0, -100, 0, 100]), 1, 1e-9);
    assert.equal(planarPointSize(2, 'points', 'EPSG:32616', () => [440_000, 4_630_000, 450_000, 4_640_000]), 2);
});

test('a layer that is not points ignores pointSize, and its extent is not read', () => {
    for (const type of ['polygons', 'polylines', 'roads', 'buildings', 'surface', 'raster', undefined]) {
        let read = false;
        const extent = () => { read = true; return [0, 0, 1, 1]; };
        assert.equal(planarPointSize(2, type, 'EPSG:3395', extent), undefined, String(type));
        assert.equal(read, false, String(type));
    }
});

test("a points layer without pointSize keeps autk-map's default, and one without points has nothing to size", () => {
    assert.equal(planarPointSize(undefined, 'points', 'EPSG:3395', () => [0, 0, 1, 1]), undefined);
    assert.equal(planarPointSize(2, 'points', 'EPSG:3395', () => undefined), undefined);
});

test('refuses a pointSize of 0, below 0 or not a number, and names the layer', () => {
    const refused = (pointSize: unknown, shown: string) => assert.throws(() => checkPointSize(pointSize, 'GPS fixes'), {
        message: `Layer "GPS fixes": pointSize must be a number of meters greater than 0, not ${shown}.`,
    });
    refused(0, '0');
    refused(-2, '-2');
    refused('2', '"2"');
    refused(null, 'null');
    refused(Number.NaN, 'NaN');
    refused(Number.POSITIVE_INFINITY, 'Infinity');
    refused([2], '[2]');
    refused({ meters: 2 }, '{"meters":2}');
    for (const pointSize of [undefined, 2, 0.5, 1e-3]) checkPointSize(pointSize, 'GPS fixes');
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
