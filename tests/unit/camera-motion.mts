// Unit tests for camera.motion: the tour player turns an autk-core Camera through autk-core's own CameraMotion, read at
// chosen times of a clock the test controls, and the tours a run refuses. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import { Camera } from '@urban-toolkit/autk-core';
import type { AutkMap } from '@urban-toolkit/autk-map';
import type { CameraMotionStep } from '@urban-toolkit/the-urban-grammar';
import type { FeatureCollection } from 'geojson';
import { keepTerrainGround, motionRefusal, playCameraMotion, tourOf, viewAngles } from '../../adapters/autk/src/camera.ts';

// The clock the test controls. CameraMotion reads performance.now() and turns the camera in requestAnimationFrame
// callbacks, each called with the time of its frame; here a frame is drawn every 16 ms, when the test says.
let now = 0;
let frames: Array<(time: number) => void> = [];
/** How many frames have been asked for. */
let asked = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true, writable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (callback: (time: number) => void) => {
        asked++;
        return frames.push(callback);
    },
    configurable: true,
    writable: true,
});
/** Lets every promise waiting on the last frame go on: a step that ended starts the next one. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Draws the frames due up to `time`, one every 16 ms. */
async function runTo(time: number): Promise<void> {
    await settle();
    while (now < time) {
        now += 16;
        const due = frames;
        frames = [];
        for (const callback of due) callback(now);
        await settle();
    }
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: number[]) => a.map((value) => value / Math.sqrt(dot(a, a)));

/**
 * A map whose camera looks at `[x, y, 0]` from `distance` away, tilted `pitch` degrees from straight down and facing
 * `bearing`, with the grammar's up direction: the view `applyCamera` sets.
 */
function mapAt(pitch: number, bearing: number, distance: number, x = 0, y = 0): AutkMap {
    const [p, b] = [radians(pitch), radians(bearing)];
    const camera = new Camera();
    camera.resetCamera(
        [Math.cos(p) * Math.sin(b), Math.cos(p) * Math.cos(b), Math.sin(p)],
        [x, y, 0],
        [x - distance * Math.sin(p) * Math.sin(b), y - distance * Math.sin(p) * Math.cos(b), distance * Math.cos(p)],
    );
    camera.resize(800, 600);
    return { camera } as unknown as AutkMap;
}

/**
 * Checks that `map`'s camera looks at `[x, y]` on the ground from `distance` away, tilted `tilt` degrees from straight
 * down, facing `heading` and banked `bank` degrees: its eye, the ground point of its line of sight, and its up direction.
 */
function expectView(map: AutkMap, name: string, view: { tilt: number; heading: number; distance: number; x: number; y: number; bank?: number }) {
    const [t, h, k] = [radians(view.tilt), radians(view.heading), radians(view.bank ?? 0)];
    const eye = map.camera.getEye();
    // The line of sight from the view matrix, as CameraMotion reads it: a roll leaves the point the camera looks at one
    // unit from the eye, too near for float32 coordinates to give the direction.
    map.camera.update();
    const matrix = map.camera.getModelViewMatrix();
    const sight = [-matrix[2], -matrix[6], -matrix[10]];
    const reach = -eye[2] / sight[2];
    const ground = [eye[0] + sight[0] * reach, eye[1] + sight[1] * reach];
    const expectedEye = [
        view.x - view.distance * Math.sin(t) * Math.sin(h),
        view.y - view.distance * Math.sin(t) * Math.cos(h),
        view.distance * Math.cos(t),
    ];
    const level = [Math.cos(t) * Math.sin(h), Math.cos(t) * Math.cos(h), Math.sin(t)];
    const side = cross(unit(expectedEye.map((value, i) => [view.x, view.y, 0][i] - value)), level);
    const expectedUp = level.map((value, i) => value * Math.cos(k) + side[i] * Math.sin(k));
    for (let i = 0; i < 3; i++)
        assert.ok(Math.abs(eye[i] - expectedEye[i]) < 1e-2, `${name}: eye ${i} is ${eye[i]}, not ${expectedEye[i]}`);
    assert.ok(Math.abs(ground[0] - view.x) < 1e-2 && Math.abs(ground[1] - view.y) < 1e-2,
        `${name}: the line of sight meets the ground at ${ground}, not ${[view.x, view.y]}`);
    const up = unit(map.camera.getUp());
    for (let i = 0; i < 3; i++)
        assert.ok(Math.abs(up[i] - expectedUp[i]) < 1e-4, `${name}: up ${i} is ${up[i]}, not ${expectedUp[i]}`);
}

// Each step type, eased in and out, at chosen times, from a view 1000 units from the origin, tilted 30 degrees and
// facing north. Each step takes 512 ms, 32 frames; at a quarter of a step the ease is 1/8 of the way, at half 1/2.
{
    const map = mapAt(30, 0, 1000);
    const start = now;
    const tour = playCameraMotion(map, [
        { type: 'zoom', amount: 1, seconds: 0.512 },
        { type: 'pitch', amount: 20, seconds: 0.512, pan: 100 },
        { type: 'bearing', amount: 90, seconds: 0.512 },
        { type: 'roll', amount: 30, seconds: 0.512 },
    ]);
    let ended = false;
    void tour.done.then(() => { ended = true; });
    assert.equal(tourOf(map), tour);

    // zoom: one level in halves the distance, 2^-ease of it on the way.
    await runTo(start + 128);
    expectView(map, 'zoom at a quarter', { tilt: 30, heading: 0, distance: 1000 * 2 ** -0.125, x: 0, y: 0 });
    await runTo(start + 256);
    expectView(map, 'zoom at half', { tilt: 30, heading: 0, distance: 1000 * 2 ** -0.5, x: 0, y: 0 });
    await runTo(start + 512);
    expectView(map, 'zoom at its end', { tilt: 30, heading: 0, distance: 500, x: 0, y: 0 });

    // pitch: 20 degrees further from straight down, the point it turns around moving 100 units north, the top of the view.
    await runTo(start + 768);
    expectView(map, 'pitch at half', { tilt: 40, heading: 0, distance: 500, x: 0, y: 50 });
    await runTo(start + 1024);
    expectView(map, 'pitch at its end', { tilt: 50, heading: 0, distance: 500, x: 0, y: 100 });

    // bearing: the heading turns clockwise, from north to east, around the point the view looks at.
    await runTo(start + 1280);
    expectView(map, 'bearing at half', { tilt: 50, heading: 45, distance: 500, x: 0, y: 100 });
    await runTo(start + 1536);
    expectView(map, 'bearing at its end', { tilt: 50, heading: 90, distance: 500, x: 0, y: 100 });

    // roll: the eye and its line of sight stay; the top of the view turns clockwise, banking the tilted view.
    await runTo(start + 1792);
    expectView(map, 'roll at half', { tilt: 50, heading: 90, distance: 500, x: 0, y: 100, bank: 15 });
    await runTo(start + 2032);
    assert.equal(ended, false, 'the tour ends with its last step, not before');
    await runTo(start + 2048);
    expectView(map, 'roll at its end', { tilt: 50, heading: 90, distance: 500, x: 0, y: 100, bank: 30 });
    assert.equal(ended, true, 'done settles once the last step ends');

    // The view's angles, as a tour played on it next reads them, and a pitch step of the banked view is refused.
    const angles = viewAngles(map.camera);
    assert.ok(typeof angles !== 'string' && Math.abs(angles.tilt - 50) < 1e-3 && Math.abs(angles.bank - 30) < 1e-3, `angles ${JSON.stringify(angles)}`);
    assert.throws(() => playCameraMotion(map, [{ type: 'pitch', amount: 5, seconds: 1 }]), /bank the tilted view 30 degrees/);
}

// A zoom out, and a pan of a view facing east: negative levels double the distance, and the pan follows the heading.
{
    const map = mapAt(45, 90, 400, 10, 20);
    const start = now;
    playCameraMotion(map, [{ type: 'zoom', amount: -1, seconds: 0.256 }, { type: 'pitch', amount: -15, seconds: 0.256, pan: -40 }]);
    await runTo(start + 256);
    expectView(map, 'zoom out at its end', { tilt: 45, heading: 90, distance: 800, x: 10, y: 20 });
    await runTo(start + 512);
    expectView(map, 'pitch back and pan back at its end', { tilt: 30, heading: 90, distance: 800, x: -30, y: 20 });
}

// stop() leaves the view where the tour had it, and settles done at once; the steps left turn nothing.
{
    const map = mapAt(30, 0, 1000);
    const start = now;
    const tour = playCameraMotion(map, [{ type: 'bearing', amount: 90, seconds: 1.024 }]);
    await runTo(start + 256);
    expectView(map, 'bearing at a quarter', { tilt: 30, heading: 11.25, distance: 1000, x: 0, y: 0 });
    tour.stop();
    await tour.done;
    await runTo(start + 2048);
    expectView(map, 'bearing stopped at a quarter', { tilt: 30, heading: 11.25, distance: 1000, x: 0, y: 0 });
}

// A stopped tour asks for no more frames, though its steps had an hour left. autk-core's CameraMotion cannot be stopped:
// each of its steps asked for a frame at every frame until its seconds were up, and so kept the map's camera, and the map
// with it, in memory long after the map was destroyed.
{
    const map = mapAt(30, 0, 1000);
    const start = now;
    const tour = playCameraMotion(map, [
        { type: 'bearing', amount: 360, seconds: 3600 },
        { type: 'zoom', amount: 1, seconds: 3600 },
    ]);
    await runTo(start + 256);
    assert.equal(frames.length, 1, 'the tour waits for its next frame');
    tour.stop();
    await tour.done;
    const before = asked;
    await runTo(start + 2048);
    assert.equal(asked - before, 0, `the stopped tour asked for ${asked - before} frames`);
    assert.equal(frames.length, 0, 'no frame is due');
    // 256 ms into an hour, the bearing had barely turned the view, and it stays where the tour had it.
    expectView(map, 'an hour of bearing stopped at 256 ms', { tilt: 30, heading: 0, distance: 1000, x: 0, y: 0 });
}

/**
 * A map whose terrain the grammar raised, as `keepTerrainGround` keeps it: heights `heightAt(x, y)` on a grid of `columns`
 * by `rows` points over `[minX, minY, maxX, maxY]` of the map's world, whose origin is [0, 0]. Its camera looks at
 * `lookAt` from `eye`, its up across the line of sight, toward the far side of the view, as applyCamera leaves it.
 */
function mapOnTerrain(bounds: number[], [columns, rows]: number[], heightAt: (x: number, y: number) => number, lookAt: number[], eye: number[]): AutkMap {
    const [minX, minY, maxX, maxY] = bounds;
    const camera = new Camera();
    const sight = unit(lookAt.map((value, i) => value - eye[i]));
    camera.resetCamera(cross(unit(cross(sight, [0, 0, 1])), sight), lookAt, eye);
    camera.resize(800, 600);
    const map = { camera, layerManager: { hasOrigin: true, origin: [0, 0] } } as unknown as AutkMap;
    // The band's heights row by row from the south, as autk-db lays out a raster's band.
    const heights = Float32Array.from({ length: columns * rows }, (_, i) =>
        heightAt(minX + ((i % columns) * (maxX - minX)) / (columns - 1), minY + (Math.floor(i / columns) * (maxY - minY)) / (rows - 1)));
    const raster = { type: 'FeatureCollection', bbox: bounds, features: [{ type: 'Feature', geometry: null, properties: { band_1: heights, rasterResX: columns, rasterResY: rows } }] };
    keepTerrainGround(map, raster as unknown as FeatureCollection, 'band_1');
    return map;
}

/** Checks that each coordinate of `point` lies within 5 cm of `expected`'s. */
function expectNear(point: number[], expected: number[], name: string) {
    for (let i = 0; i < 3; i++)
        assert.ok(Math.abs(point[i] - expected[i]) < 0.05, `${name}: coordinate ${i} is ${point[i]}, not ${expected[i]}`);
}

// Ground 8 km long and 2 km wide, rising from 0 m at its south end to 800 m at its north end, with a point every 100 m
// from south to north.
const slope = { bounds: [-1000, -4000, 1000, 4000], grid: [3, 81], heightAt: (_: number, y: number) => 400 + y / 10 };

// A tour on sloped ground turns the view around the ground its line of sight meets, ahead of the eye, though the ground
// rises along the view faster than the line of sight falls: from zoom 11.5, 85 degrees from straight down, looking north
// at the middle of the slope, 400 m high. The search for that ground stopped at a height above the eye, and the zoom step
// turned the view around a point behind it.
{
    const [distance, tilt] = [10000 / 2 ** 1.5, radians(85)];
    const middle = [0, 0, 400];
    const map = mapOnTerrain(slope.bounds, slope.grid, slope.heightAt, middle, [0, -distance * Math.sin(tilt), 400 + distance * Math.cos(tilt)]);
    const start = now;
    const tour = playCameraMotion(map, [{ type: 'zoom', amount: 1, seconds: 0.512 }]);
    await runTo(start + 512);
    await tour.done;
    // A zoom level in halves the eye's distance from the middle.
    expectNear(map.camera.getLookAt(), middle, 'the point a zoom on the slope turned the view around');
    expectNear(map.camera.getEye(), [0, (-distance / 2) * Math.sin(tilt), 400 + (distance / 2) * Math.cos(tilt)], 'the eye after a zoom on the slope');
}

// With the eye under the ground, its line of sight meets no ground ahead: a step turns the view around the point the
// camera looks at, ahead of the eye. It turned the view around the ground under the eye, above it, so a zoom in moved
// the eye back. Here the eye is 100 m under the slope, 2 km north of its middle, and looks north 60 degrees from
// straight down at a point 400 m ahead.
{
    const tilt = radians(60);
    const eye = [0, 2000, 500];
    const lookAt = [0, 2000 + 400 * Math.sin(tilt), 500 - 400 * Math.cos(tilt)];
    const map = mapOnTerrain(slope.bounds, slope.grid, slope.heightAt, lookAt, eye);
    const start = now;
    const tour = playCameraMotion(map, [{ type: 'zoom', amount: 1, seconds: 0.512 }]);
    await runTo(start + 512);
    await tour.done;
    expectNear(map.camera.getLookAt(), lookAt, 'the point a zoom under the ground turned the view around');
    expectNear(map.camera.getEye(), [0, 2000 + 200 * Math.sin(tilt), 500 - 200 * Math.cos(tilt)], 'the eye after a zoom under the ground');
}

// A tour played on a map stops the one it plays, and starts from its view.
{
    const map = mapAt(30, 0, 1000);
    const start = now;
    const first = playCameraMotion(map, [{ type: 'bearing', amount: 90, seconds: 1.024 }]);
    await runTo(start + 256);
    const second = playCameraMotion(map, [{ type: 'zoom', amount: 1, seconds: 0.512 }]);
    await first.done;
    assert.equal(tourOf(map), second);
    await runTo(start + 768);
    await second.done;
    await runTo(start + 2048);
    expectView(map, 'the first tour stopped, the second ended', { tilt: 30, heading: 11.25, distance: 500, x: 0, y: 0 });
}

// The tours a run refuses, from a view tilted 30 degrees (motionRefusal), and a view no tour starts from.
{
    const step = (fields: Record<string, unknown>) => ({ type: 'zoom', amount: 1, seconds: 1, ...fields });
    const refusal = (motion: unknown, tilt = 30) => motionRefusal(motion, { tilt, bank: 0 });
    assert.equal(refusal(undefined), undefined);
    assert.equal(refusal([]), undefined);
    assert.equal(refusal({ type: 'zoom' }), 'camera.motion must be a list of steps, not {"type":"zoom"}.');
    assert.equal(refusal(['zoom']), 'camera.motion[0] must be a step { type, amount, seconds }, not "zoom".');
    assert.equal(refusal([step({ type: 'spin' })]), 'camera.motion[0]: type must be zoom, pitch, bearing or roll, not "spin".');
    assert.equal(refusal([step({ amount: '1' })]), 'camera.motion[0]: amount must be a number, not "1".');
    assert.equal(refusal([step({ amount: NaN })]), 'camera.motion[0]: amount must be a number, not NaN.');
    assert.equal(refusal([step({}), step({ seconds: 0 })]), 'camera.motion[1]: seconds must be a number greater than 0, not 0.');
    assert.equal(refusal([step({ seconds: -1 })]), 'camera.motion[0]: seconds must be a number greater than 0, not -1.');
    assert.equal(refusal([step({ pan: 10 })]), 'camera.motion[0]: pan moves the point a pitch step turns the view around, and a zoom step takes none.');
    assert.equal(refusal([step({ type: 'pitch', amount: 10, pan: '10' })]), 'camera.motion[0]: pan must be a number of workspace units, not "10".');

    // The tilt the pitch steps add up to stays at least 0 and less than 90, as camera.pitch does.
    assert.equal(refusal([step({ type: 'pitch', amount: 59.9 })]), undefined);
    assert.match(refusal([step({ type: 'pitch', amount: 60 })]) ?? '', /^camera\.motion\[0\]: this pitch step would tilt the view 90 degrees from straight down\./);
    assert.match(refusal([step({ type: 'pitch', amount: 30 }), step({ type: 'pitch', amount: 30 })]) ?? '', /^camera\.motion\[1\]: this pitch step would tilt the view 90 degrees/);
    assert.match(refusal([step({ type: 'pitch', amount: -40 })]) ?? '', /^camera\.motion\[0\]: this pitch step would tilt the view -10 degrees/);
    assert.equal(refusal([step({ type: 'pitch', amount: -30 })]), undefined, 'back to straight down');

    // A roll of a tilted view banks it, and its pitch steps wait until rolls undo the bank. A roll of a view that looks
    // straight down turns its heading and leaves no bank.
    assert.match(refusal([step({ type: 'roll', amount: 20 }), step({ type: 'pitch', amount: 10 })]) ?? '', /^camera\.motion\[1\]: the rolls before this pitch step bank the tilted view 20 degrees/);
    assert.equal(refusal([step({ type: 'roll', amount: 20 }), step({ type: 'roll', amount: -20 }), step({ type: 'pitch', amount: 10 })]), undefined);
    assert.equal(refusal([step({ type: 'roll', amount: 360 }), step({ type: 'pitch', amount: 10 })]), undefined);
    assert.equal(refusal([step({ type: 'roll', amount: 45 }), step({ type: 'pitch', amount: 30 })], 0), undefined);
    assert.equal(refusal([step({ type: 'bearing', amount: 120 }), step({ type: 'zoom', amount: -2 }), step({ type: 'pitch', amount: 59 })]), undefined);

    // A view that looks at the horizon meets no ground ahead, so no tour starts from it.
    const level = new Camera({ up: [0, 0, 1], lookAt: [0, 1000, 100], eye: [0, 0, 100] });
    level.resize(800, 600);
    assert.throws(() => playCameraMotion({ camera: level } as unknown as AutkMap, [step({})] as CameraMotionStep[]),
        { message: 'camera.motion: the view looks at or above the horizon, so a tour would have no point of the ground to turn it around.' });
    const angles = viewAngles(mapAt(30, 45, 1000).camera);
    assert.ok(typeof angles !== 'string' && Math.abs(angles.tilt - 30) < 1e-3 && Math.abs(angles.bank) < 1e-3, `angles ${JSON.stringify(angles)}`);
}

console.log('camera-motion: all cases passed');
