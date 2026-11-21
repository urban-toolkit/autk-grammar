import type { FeatureCollection } from 'geojson';
import type { CameraMotionStep } from '@urban-toolkit/the-urban-grammar';
import type { AutkDb } from '@urban-toolkit/autk-db';
import type { AutkMap } from '@urban-toolkit/autk-map';
import { CameraMotion } from '@urban-toolkit/autk-core';
import type { Camera } from '@urban-toolkit/autk-core';

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
 * It refuses a center autk-db's transform gives no point for: an error, or a coordinate that is not a finite number.
 * PROJ gives Mercator a finite point even at a pole, about 242,000 km from the equator.
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

/**
 * The ground of a map's terrain as autk-map raises it from a raster band (autk-core's `heightfieldFromRaster`): the band's
 * heights on a grid of `width` by `height` points from the raster's south-west corner, in the map's world, `cellSizeX` and
 * `cellSizeY` apart, a height that is not a finite number lying at 0.
 */
type Ground = { values: ArrayLike<number>; width: number; height: number; originX: number; originY: number; cellSizeX: number; cellSizeY: number };

/** The ground of each map whose terrain the grammar raised, which its camera and its tours are measured from. */
const grounds = new WeakMap<AutkMap, Ground>();

/**
 * Keeps the ground of the terrain autk-map raised on `map` from the band `band` of `raster`, so that `applyCamera` and the
 * tours `playCameraMotion` plays on the map measure the camera from it. The map adapter calls it once autk-map's
 * `enableTerrainMode` took the raster.
 */
export function keepTerrainGround(map: AutkMap, raster: FeatureCollection, band: string): void {
    const props = raster.features?.[0]?.properties as Record<string, unknown> | null | undefined;
    const values = props?.[band];
    const bbox = raster.bbox;
    if (!bbox || !map.layerManager.hasOrigin || !(Array.isArray(values) || (ArrayBuffer.isView(values) && !(values instanceof DataView)))) return;
    const [ox, oy] = map.layerManager.origin;
    const [minX, minY, maxX, maxY] = [0, 1, 2, 3].map((i) => Number(bbox[i]));
    const [width, height] = [Number(props?.rasterResX), Number(props?.rasterResY)];
    const [cellSizeX, cellSizeY] = [(maxX - minX) / (width - 1), (maxY - minY) / (height - 1)];
    if (!(width >= 2 && height >= 2 && cellSizeX > 0 && cellSizeY > 0 && Number.isFinite(minX - ox) && Number.isFinite(minY - oy))) return;
    grounds.set(map, { values: values as ArrayLike<number>, width, height, originX: minX - ox, originY: minY - oy, cellSizeX, cellSizeY });
}

/**
 * The height of `ground` at `[x, y]` of its map's world, as autk-map 4.1.1's terrain draws it (`terrainHeight` in its
 * terrain.vert.wgsl): between the four points of the grid around it, the point held within the grid up to its last cell
 * but one.
 */
function heightOn(ground: Ground, x: number, y: number): number {
    const { values, width, height } = ground;
    const at = (column: number, row: number) => {
        const value = Number(values[row * width + column]);
        return Number.isFinite(value) ? value : 0;
    };
    const within = (value: number, high: number) => Math.min(Math.max(value, 0), high);
    const u = within((x - ground.originX) / ground.cellSizeX, width - 2);
    const v = within((y - ground.originY) / ground.cellSizeY, height - 2);
    const [column, row] = [Math.floor(u), Math.floor(v)];
    const [s, t] = [u - column, v - row];
    const south = at(column, row) * (1 - s) + at(column + 1, row) * s;
    const north = at(column, row + 1) * (1 - s) + at(column + 1, row + 1) * s;
    return south * (1 - t) + north * t;
}

/**
 * The height of the ground at `[x, y]` of `map`'s world: the terrain's there, on a map whose terrain the grammar raised,
 * else 0, the height autk-map draws a map's flat layers at.
 */
export function groundHeight(map: AutkMap, x: number, y: number): number {
    const ground = grounds.get(map);
    return ground ? heightOn(ground, x, y) : 0;
}

/**
 * The height of the ground where the line of sight of the view matrix `m` meets it, reached from the ground under the
 * eye, height by height; a line of sight at or above the horizon keeps the height under the eye. The eye and the line of
 * sight are read from the matrix as autk-core's CameraMotion reads them.
 */
function sightGround(ground: Ground, m: ArrayLike<number>): number {
    const eye = [
        -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
        -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
        -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]),
    ];
    const sight = [-m[2], -m[6], -m[10]];
    let z = heightOn(ground, eye[0], eye[1]);
    for (let round = 0; round < 32 && sight[2] < 0; round++) {
        const reach = (eye[2] - z) / -sight[2];
        if (!(reach > 0)) break;
        const next = heightOn(ground, eye[0] + sight[0] * reach, eye[1] + sight[1] * reach);
        const settled = Math.abs(next - z) < 1e-6;
        z = next;
        if (settled) break;
    }
    return z;
}

/** The view matrix `m` of a world lowered by `lift`: what stands at height `lift` stands at 0 in it. */
function lowered(m: ArrayLike<number>, lift: number): Float32Array {
    const matrix = Float32Array.from(m);
    matrix[12] += lift * m[8];
    matrix[13] += lift * m[9];
    matrix[14] += lift * m[10];
    return matrix;
}

/** The tilt of a view from straight down and its bank, in degrees, as the steps of a tour change them. */
export type ViewAngles = { tilt: number; bank: number };

/** A camera tour playing on a map: `done` settles once its last step ends, or at once when the tour is stopped. */
export type CameraTour = { readonly done: Promise<void>; stop(): void };

const STEP_TYPES: ReadonlyArray<CameraMotionStep['type']> = ['zoom', 'pitch', 'bearing', 'roll'];

/** How far an angle read from a camera's float32 matrix, in degrees, may lie from another and still be the same. */
const ANGLE_TOLERANCE = 1e-3;

const shown = (value: unknown): string => (typeof value === 'number' ? String(value) : JSON.stringify(value) ?? String(value));
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** An angle in degrees as a message shows it: to a thousandth, which a camera's float32 matrix holds. */
const rounded = (angle: number): string => String(Number(angle.toFixed(3)));
const degrees = (radians: number): number => (radians * 180) / Math.PI;
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: number[]): number[] => a.map((value) => value / Math.hypot(a[0], a[1], a[2]));

/** Whether an angle in degrees is a whole number of turns. */
function noTurn(angle: number): boolean {
    const rest = ((angle % 360) + 360) % 360;
    return rest < ANGLE_TOLERANCE || 360 - rest < ANGLE_TOLERANCE;
}

/**
 * Why a run refuses `camera.motion`, or `undefined` when it takes it, for a tour that starts from a view of the tilt and
 * bank `start` gives. Each step needs a known `type`, a number `amount` and `seconds` greater than 0, by which
 * autk-core divides, and only a `pitch` step takes a `pan`.
 *
 * The tilt the `pitch` steps add up to, from the start's, stays at least 0 and less than 90 degrees, as `camera.pitch`
 * does: at 90 the line of sight would meet the ground nowhere, and the next step would have no point to turn around. A
 * `roll` of a tilted view banks it, and a `pitch` step turns the view around its side, so a `pitch` step of a banked
 * view would also turn its heading: it is refused until rolls undo the bank. A `roll` of a view that looks straight down
 * turns its heading and leaves no bank.
 */
export function motionRefusal(motion: unknown, start: ViewAngles): string | undefined {
    if (motion === undefined) return undefined;
    if (!Array.isArray(motion)) return `camera.motion must be a list of steps, not ${shown(motion)}.`;
    let { tilt, bank } = start;
    for (let i = 0; i < motion.length; i++) {
        const step: unknown = motion[i];
        const at = `camera.motion[${i}]`;
        if (step === null || typeof step !== 'object' || Array.isArray(step))
            return `${at} must be a step { type, amount, seconds }, not ${shown(step)}.`;
        const { type, amount, seconds, pan } = step as Record<string, unknown>;
        if (!(STEP_TYPES as readonly unknown[]).includes(type))
            return `${at}: type must be zoom, pitch, bearing or roll, not ${shown(type)}.`;
        if (!isNumber(amount)) return `${at}: amount must be a number, not ${shown(amount)}.`;
        if (!isNumber(seconds) || seconds <= 0)
            return `${at}: seconds must be a number greater than 0, not ${shown(seconds)}.`;
        if (pan !== undefined && type !== 'pitch')
            return `${at}: pan moves the point a pitch step turns the view around, and a ${type} step takes none.`;
        if (pan !== undefined && !isNumber(pan)) return `${at}: pan must be a number of workspace units, not ${shown(pan)}.`;
        if (type === 'roll' && tilt > ANGLE_TOLERANCE) bank += amount;
        if (type !== 'pitch') continue;
        if (!noTurn(bank))
            return `${at}: the rolls before this pitch step bank the tilted view ${rounded(bank)} degrees, and a pitch step of a banked view would also turn its heading. Roll the view back before it, or roll after the last pitch step.`;
        tilt += amount;
        if (tilt < -ANGLE_TOLERANCE || tilt >= 90)
            return `${at}: this pitch step would tilt the view ${rounded(tilt)} degrees from straight down. The camera's pitch and the tour's pitch steps add up to a tilt that stays at least 0 and less than 90 degrees, as camera.pitch does: at 90 the line of sight would meet the ground nowhere.`;
    }
    return undefined;
}

/**
 * The tilt and bank of `camera`'s view, the start of a tour played on it, read from its view matrix as autk-core's
 * CameraMotion reads it; or why no tour starts from it: a line of sight at or above the horizon meets no ground ahead,
 * so a step would have no point to turn the view around.
 */
export function viewAngles(camera: Pick<Camera, 'update' | 'getModelViewMatrix'>): ViewAngles | string {
    camera.update();
    const m = camera.getModelViewMatrix();
    const side = [m[0], m[4], m[8]];
    const sight = [-m[2], -m[6], -m[10]];
    if (!(sight[2] < 0)) return 'the view looks at or above the horizon, so a tour would have no point of the ground to turn it around.';
    const tilt = degrees(Math.acos(Math.min(1, -sight[2])));
    // Unbanked, the view's side is level: across the line of sight and the vertical.
    const level = cross(sight, [0, 0, 1]);
    if (tilt <= ANGLE_TOLERANCE || Math.hypot(level[0], level[1], level[2]) === 0) return { tilt, bank: 0 };
    const flat = unit(level);
    return { tilt, bank: degrees(Math.atan2(dot(sight, cross(flat, side)), dot(flat, side))) };
}

/** The tour each map plays or last played: a map plays one at a time. */
const tours = new WeakMap<AutkMap, CameraTour>();

/** The tour `map` plays, or last played, if any. */
export function tourOf(map: AutkMap): CameraTour | undefined {
    return tours.get(map);
}

/**
 * Calls `stop` when the user drags, scrolls or presses a key on `canvas`, and returns what stops listening. autk-map
 * hears a drag on the page, before the canvas, and stops the pointer event there, so the drag is heard on the page too.
 */
function onUserInput(canvas: HTMLCanvasElement | undefined, stop: () => void): () => void {
    if (!canvas || typeof document === 'undefined') return () => {};
    const heard = (event: Event) => {
        if (event.target === canvas) stop();
    };
    const onPage = { capture: true };
    document.addEventListener('pointerdown', heard, onPage);
    document.addEventListener('wheel', heard, onPage);
    canvas.addEventListener('keyup', heard);
    return () => {
        document.removeEventListener('pointerdown', heard, onPage);
        document.removeEventListener('wheel', heard, onPage);
        canvas.removeEventListener('keyup', heard);
    };
}

/** Queues `step` on autk-core's CameraMotion, whose amounts and pans have signs of their own. */
function queueStep(motion: CameraMotion, step: CameraMotionStep): void {
    switch (step.type) {
        case 'zoom':
            // A zoom level halves the eye's distance: autk-core's zoomIn divides the distance by its factor, and its
            // zoomOut multiplies it.
            if (step.amount >= 0) motion.zoomIn(2 ** step.amount, step.seconds);
            else motion.zoomOut(2 ** -step.amount, step.seconds);
            break;
        case 'pitch':
            // autk-core tilts away from straight down for a negative angle, and moves the point it turns the view around
            // toward the bottom of the view for a positive pan.
            motion.pitch(-step.amount, step.seconds, -(step.pan ?? 0));
            break;
        case 'bearing':
            // autk-core's yaw turns the heading counterclockwise for a positive angle.
            motion.yaw(-step.amount, step.seconds);
            break;
        case 'roll':
            motion.roll(step.amount, step.seconds);
            break;
    }
}

/**
 * Plays `motion`, a camera tour, on `map` through autk-core's `CameraMotion`, from the view its camera has now, and
 * returns the tour without waiting for it. Each step takes its own `seconds`, easing in and out, and sets the camera at
 * every animation frame, so the map draws each one. The tour stops when the user drags, scrolls or presses a key on the
 * map, which hands the camera to the map's own pan, tilt and zoom, and when another tour is played on the map. A stopped
 * tour lets go of the map at once and asks for no more frames. It refuses a tour `motionRefusal` refuses from the map's
 * view. On a map whose terrain the grammar raised, each step turns the view around the ground its line of sight meets as
 * the step starts.
 *
 * The map adapter calls it once a map is drawn, when its `camera` has a `motion`. A host that frames a map itself and
 * then turns it with `applyCamera` calls it after that turn, so the tour starts from the host's view.
 */
export function playCameraMotion(map: AutkMap, motion: CameraMotionStep[]): CameraTour {
    const angles = viewAngles(map.camera);
    if (typeof angles === 'string') throw new Error(`camera.motion: ${angles}`);
    const refused = motionRefusal(motion, angles);
    if (refused) throw new Error(refused);

    tours.get(map)?.stop();
    let settle = (): void => {};
    const stopping = new Promise<void>((resolve) => {
        settle = resolve;
    });
    // CameraMotion turns the view around the point where its line of sight meets z = 0, which on a terrain the grammar
    // raised lies under the ground. So as each step starts, it reads the view of a world lowered by the height of the
    // ground the line of sight meets (`lift`), and the views it sets are raised back by as much: the step turns the view
    // around that ground.
    let ground = grounds.get(map);
    let lift = 0;
    // CameraMotion cannot be stopped, so it turns a stand-in of the map's camera, which reaches the camera only while the
    // tour plays (`view`): a stopped tour lets go of the camera, and of the map with it, at once.
    let view: Camera | undefined = map.camera;
    const steps = new CameraMotion();
    for (const step of motion) queueStep(steps, step);
    // autk-core 4.1.1's CameraMotion asks for another frame at each frame of a step while the step's progress, its time so
    // far over its `durationMs`, which it reads at each frame, is below 1. A stopped tour gives each step a `durationMs` of
    // NaN, so the frame the playing step already asked for ends it, and the next step, which finds no camera as it starts,
    // ends the tour: a stopped tour asks for no more frames.
    const queued = (steps as unknown as { steps?: unknown }).steps;
    let unlisten = (): void => {};
    const letGo = (): void => {
        view = undefined;
        ground = undefined;
        unlisten();
        unlisten = () => {};
    };
    const stop = (): void => {
        letGo();
        if (Array.isArray(queued)) {
            for (const step of queued) {
                if (step !== null && typeof step === 'object') (step as { durationMs?: number }).durationMs = NaN;
            }
        }
        settle();
    };
    unlisten = onUserInput((map as { canvas?: HTMLCanvasElement }).canvas, stop);
    const standIn = new Proxy({} as Camera, {
        get(_, key) {
            const camera = view;
            if (!camera) {
                if (key === 'getModelViewMatrix') return () => { throw new Error('The camera tour was stopped.'); };
                return () => {};
            }
            const terrain = ground;
            if (terrain && key === 'getModelViewMatrix') {
                return () => {
                    const matrix = camera.getModelViewMatrix();
                    lift = sightGround(terrain, matrix);
                    return lowered(matrix, lift);
                };
            }
            if (terrain && key === 'resetCamera') {
                return (up: number[], lookAt: number[], eye: number[]) =>
                    camera.resetCamera(up, [lookAt[0], lookAt[1], lookAt[2] + lift], [eye[0], eye[1], eye[2] + lift]);
            }
            const value: unknown = Reflect.get(camera, key);
            return typeof value === 'function' ? value.bind(camera) : value;
        },
    });
    // A tour that ended lets go of the camera too.
    const done = Promise.race([steps.play(standIn), stopping]).finally(letGo);
    const tour: CameraTour = { done, stop };
    tours.set(map, tour);
    return tour;
}
