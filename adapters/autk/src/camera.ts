import type { AutkDb } from '@urban-toolkit/autk-db';
import type { AutkMap } from '@urban-toolkit/autk-map';

/**
 * The point each map's `camera.center` names, in the CRS of the map's workspace, as `resolveCameraCenter` put it there.
 * It is kept with the map, so `applyCamera` looks at it each time it turns the map, a host's later turns included.
 */
const centers = new WeakMap<AutkMap, { center: [number, number]; point: [number, number] }>();

/** Why a run refuses `camera.center`, or `undefined` when it is absent or `[longitude, latitude]` in degrees. */
export function centerRefusal(center: unknown): string | undefined {
    if (center === undefined) return undefined;
    const valid = Array.isArray(center) && center.length === 2
        && center.every((value) => typeof value === 'number' && Number.isFinite(value))
        && Math.abs(center[0]) <= 180 && Math.abs(center[1]) <= 90;
    return valid ? undefined
        : `camera.center must be [longitude, latitude] in degrees, the longitude from -180 to 180 and the latitude from -90 to 90, not ${JSON.stringify(center)}.`;
}

/**
 * Puts `center`, `[longitude, latitude]` in degrees, in the CRS of the workspace `db` works in, with autk-db's own
 * transform, as autk-db puts a source's coordinates there, and keeps it with `map`, so that `applyCamera(map, camera)`
 * looks at it. The map adapter calls it once a map's layers are loaded, with the map's workspace current; a host that
 * builds its own map from a spec's `map` entry calls it at the same point, after `enterWorkspace(db, map.workspace)`.
 * It refuses a center the CRS has no point for, such as a pole in Mercator.
 */
export async function resolveCameraCenter(db: AutkDb, map: AutkMap, center: [number, number]): Promise<void> {
    const refused = centerRefusal(center);
    if (refused) throw new Error(refused);
    const [lon, lat] = center;
    const crs = db.getWorkspaceConfiguration().coordinateFormat;
    const noPoint = `camera.center [${lon}, ${lat}] has no point in ${crs}, the CRS of the map's workspace`;
    let rows: unknown;
    try {
        rows = await db.rawQuery({
            query: `SELECT ST_X(p) AS x, ST_Y(p) AS y FROM (SELECT ST_Transform(ST_Point(${lon}, ${lat}), 'EPSG:4326', '${crs.replace(/'/g, "''")}', always_xy := true) AS p)`,
            output: { type: 'RETURN_OBJECT' },
        });
    } catch (error) {
        throw new Error(`${noPoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A transform PROJ cannot make comes back as an infinite or NULL coordinate, so only two finite numbers are a point.
    const row = Array.isArray(rows) ? rows[0] as { x?: unknown; y?: unknown } | undefined : undefined;
    const point = [row?.x, row?.y].map((value) => (typeof value === 'number' ? value : NaN)) as [number, number];
    if (!point.every(Number.isFinite)) throw new Error(`${noPoint}.`);
    centers.set(map, { center: [lon, lat], point });
}

/**
 * Where `center` lies in `map`'s world, the space its camera stands in: the point `resolveCameraCenter` kept for the
 * map, less the map's origin, since autk-map draws every layer relative to the middle of the first one it loaded. It
 * refuses a center no `resolveCameraCenter` call kept for the map.
 */
export function centerOnMap(map: AutkMap, center: [number, number]): [number, number] {
    const kept = centers.get(map);
    if (!kept || kept.center[0] !== center[0] || kept.center[1] !== center[1])
        throw new Error(`camera.center [${center.join(', ')}] has no point on this map yet: resolveCameraCenter(db, map, center) puts it in the CRS of the map's workspace, as the grammar does for the maps it draws.`);
    const [ox, oy] = map.layerManager.hasOrigin ? map.layerManager.origin : [0, 0];
    return [kept.point[0] - ox, kept.point[1] - oy];
}
