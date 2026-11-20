// Unit tests for camera.center: the query that puts it in the CRS of the map's workspace, the point a map keeps, and
// the centers refused, with a stand-in for autk-db that answers as the test says. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import type { AutkDb } from '@urban-toolkit/autk-db';
import type { AutkMap } from '@urban-toolkit/autk-map';
import { centerOnMap, centerRefusal, resolveCameraCenter } from '../../adapters/autk/src/camera.ts';

/** A stand-in for autk-db: its workspace's CRS, and the rows (or the error) its rawQuery gives, which keeps the query. */
function database(crs: string, answer: () => unknown) {
    const queries: Array<{ query: string; output: { type: string } }> = [];
    const db = {
        getWorkspaceConfiguration: () => ({ coordinateFormat: crs, precisionGrid: 0.01 }),
        rawQuery: async (params: { query: string; output: { type: string } }) => {
            queries.push(params);
            return answer();
        },
    };
    return { db: db as unknown as AutkDb, queries };
}

/** A stand-in for autk-map's map, its world relative to `origin`, or to nothing before a layer gave it one. */
const mapAt = (origin?: [number, number]) => ({ layerManager: { hasOrigin: origin !== undefined, origin } }) as unknown as AutkMap;

// The query is autk-db's own transform, from degrees to the workspace's CRS, longitude first, and its rows come back.
{
    const { db, queries } = database('EPSG:3395', () => [{ x: -8235638.567867965, y: 4947858.061870947 }]);
    const map = mapAt([-8235400, 4948400]);
    await resolveCameraCenter(db, map, [-73.982, 40.7515]);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].query,
        "SELECT ST_X(p) AS x, ST_Y(p) AS y FROM (SELECT ST_Transform(ST_Point(-73.982, 40.7515), 'EPSG:4326', 'EPSG:3395', always_xy := true) AS p)");
    assert.deepEqual(queries[0].output, { type: 'RETURN_OBJECT' });
    // The map's camera stands in its world, relative to its origin.
    const [x, y] = centerOnMap(map, [-73.982, 40.7515]);
    assert.ok(Math.abs(x - (-238.567867965)) < 1e-6 && Math.abs(y - (-541.938129053)) < 1e-6, `${x}, ${y}`);
    // Another center was never put on this map, and a map with no layer yet has no origin to be relative to.
    assert.throws(() => centerOnMap(map, [-73.98, 40.75]),
        { message: "camera.center [-73.98, 40.75] has no point on this map yet: resolveCameraCenter(db, map, center) puts it in the CRS of the map's workspace, as the grammar does for the maps it draws." });
    const bare = mapAt();
    await resolveCameraCenter(database('EPSG:3857', () => [{ x: 10, y: 20 }]).db, bare, [0.1, 0.2]);
    assert.deepEqual(centerOnMap(bare, [0.1, 0.2]), [10, 20]);
}

// A quote in the CRS stays inside its string.
{
    const { db, queries } = database("EPSG:3395'; SELECT 1 --", () => [{ x: 1, y: 2 }]);
    await resolveCameraCenter(db, mapAt([0, 0]), [1, 2]);
    assert.match(queries[0].query, /'EPSG:3395''; SELECT 1 --'/);
}

// A transform that gives no point is refused, naming the center and the CRS: an infinite or missing coordinate, no
// row, or autk-db's error, whose reason follows.
{
    const refused = async (answer: () => unknown) => {
        const map = mapAt([0, 0]);
        await assert.rejects(resolveCameraCenter(database('EPSG:3395', answer).db, map, [-73.98, 40.75]), (error: Error) => {
            assert.match(error.message, /^camera\.center \[-73\.98, 40\.75\] has no point in EPSG:3395, the CRS of the map's workspace/);
            return true;
        });
        // Nothing is kept for the map.
        assert.throws(() => centerOnMap(map, [-73.98, 40.75]), /has no point on this map yet/);
    };
    await refused(() => [{ x: Infinity, y: 4947858 }]);
    await refused(() => [{ x: null, y: null }]);
    await refused(() => [{ x: '1', y: '2' }]);
    await refused(() => []);
    await refused(() => { throw new Error('Invalid Input Error: no CRS'); });
    await assert.rejects(resolveCameraCenter(database('EPSG:9999', () => { throw new Error('no CRS 9999'); }).db, mapAt([0, 0]), [1, 2]),
        { message: "camera.center [1, 2] has no point in EPSG:9999, the CRS of the map's workspace: no CRS 9999" });
}

// The centers a run refuses before it asks autk-db: not two numbers, or out of the degrees' ranges.
{
    assert.equal(centerRefusal(undefined), undefined);
    assert.equal(centerRefusal([-180, 90]), undefined);
    for (const center of [[-73.98, 40.75, 0], [-73.98], [181, 0], [0, -90.5], ['-73.98', '40.75'], { lon: 1, lat: 2 }, [NaN, 0], null])
        assert.equal(centerRefusal(center),
            `camera.center must be [longitude, latitude] in degrees, the longitude from -180 to 180 and the latitude from -90 to 90, not ${JSON.stringify(center)}.`);
    const { db, queries } = database('EPSG:3395', () => [{ x: 1, y: 2 }]);
    await assert.rejects(resolveCameraCenter(db, mapAt([0, 0]), [200, 0]), /camera\.center must be \[longitude, latitude\] in degrees/);
    assert.equal(queries.length, 0, 'a center out of range is refused before any query');
}

console.log('camera-center: all cases passed');
