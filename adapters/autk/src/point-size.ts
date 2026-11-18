/**
 * A points layer's `pointSize`, the radius of its points in meters on the ground, as autk-map's `pointSize`, a radius
 * in the workspace's planar units. Nothing here needs a GPU or a database, so the unit tests run it in Node.
 */

/** WGS84's semi-major axis, in meters: the radius of Web Mercator's sphere and of World Mercator's ellipsoid. */
const WGS84_A = 6378137;

/** WGS84's first eccentricity, which shapes World Mercator's ellipsoid. */
const WGS84_E = 0.0818191908426215;

/** Refuses a `pointSize` that is not a number of meters greater than 0, naming the layer. An unset one passes. */
export function checkPointSize(pointSize: unknown, layerId: string): void {
    if (pointSize === undefined) return;
    if (typeof pointSize === 'number' && Number.isFinite(pointSize) && pointSize > 0) return;
    const shown = typeof pointSize === 'number' ? String(pointSize) : JSON.stringify(pointSize);
    throw new Error(`Layer "${layerId}": pointSize must be a number of meters greater than 0, not ${shown}.`);
}

/** The latitude, in radians, of a World Mercator (EPSG:3395) planar y, on the WGS84 ellipsoid. */
function worldMercatorLatitude(y: number): number {
    const t = Math.exp(-y / WGS84_A);
    let phi = Math.PI / 2 - 2 * Math.atan(t);
    for (let i = 0; i < 10; i++) {
        const s = WGS84_E * Math.sin(phi);
        const next = Math.PI / 2 - 2 * Math.atan(t * ((1 - s) / (1 + s)) ** (WGS84_E / 2));
        if (Math.abs(next - phi) < 1e-12) return next;
        phi = next;
    }
    return phi;
}

/**
 * How many planar units of the workspace CRS `crs` one meter on the ground spans at the planar y `y`: Mercator's scale
 * factor at the latitude φ of `y`. In World Mercator (EPSG:3395, autk-db's default), on the WGS84 ellipsoid, it is
 * sec φ times sqrt(1 - e² sin² φ); in Web Mercator (EPSG:3857), on a sphere, sec φ. Any other CRS is taken as
 * projected in meters, so a meter is one planar unit.
 */
export function planarUnitsPerMeter(crs: string, y: number): number {
    if (/^EPSG:3395$/i.test(crs)) {
        const phi = worldMercatorLatitude(y);
        const s = WGS84_E * Math.sin(phi);
        return Math.sqrt(1 - s * s) / Math.cos(phi);
    }
    // On the sphere, sec φ of the latitude of y is cosh(y / a).
    if (/^EPSG:3857$/i.test(crs)) return Math.cosh(y / WGS84_A);
    return 1;
}

/**
 * The radius autk-map draws a layer's points with, in the planar units of the workspace CRS `crs`: `pointSize` meters
 * at the middle of the layer's planar y. `extent` gives the layer's `[minX, minY, maxX, maxY]` in workspace units, or
 * `undefined` when it has no points, and is read only for a points layer that sets `pointSize`. `undefined` when the
 * layer sets none, which keeps autk-map's default, when it is not a points layer, which ignores it, and when it has
 * no points.
 */
export function planarPointSize(
    pointSize: number | undefined,
    type: string | undefined,
    crs: string,
    extent: () => readonly number[] | undefined,
): number | undefined {
    if (pointSize === undefined || type !== 'points') return undefined;
    const box = extent();
    if (!box) return undefined;
    return pointSize * planarUnitsPerMeter(crs, (box[1] + box[3]) / 2);
}
