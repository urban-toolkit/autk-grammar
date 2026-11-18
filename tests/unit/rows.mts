// Unit tests for how a selection passes between a plot and a map layer: by the rows each drew, each row named by its
// feature id. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import type { Feature } from 'geojson';
import { featureIds, rowKeys, translateIds } from '../../adapters/autk/src/rows.ts';

/** A feature named `name`, with an `id` when given, and a point unless `geometry` is false. */
function row(name: string, { id, geometry = true }: { id?: string | number; geometry?: boolean } = {}): Feature {
    return {
        type: 'Feature',
        ...(id !== undefined && { id }),
        properties: { name },
        geometry: geometry ? { type: 'Point', coordinates: [0, 0] } : null,
    } as Feature;
}

/** The keys of the rows a map layer draws: those with a geometry, in the order of `exported`, as the map adapter keeps them. */
function layerKeys(exported: Feature[]): string[] {
    const keys = rowKeys(exported);
    return exported.flatMap((feature, index) => (feature.geometry != null ? [keys[index]] : []));
}

/** The rows autk-db exports for `handed`: each with the id it was handed, in the order `order` gives. */
function exportOf(handed: Feature[], order: number[]): Feature[] {
    const ids = featureIds(handed);
    return order.map((index) => ({ ...handed[index], id: ids[index] }));
}

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test('a feature keeps its id, and one without gets autk-feature-<index>, as autk-db names it', () => {
    assert.deepEqual(featureIds([row('a', { id: 7 }), row('b'), row('c', { id: 'x' }), row('d')]), [7, 'autk-feature-1', 'x', 'autk-feature-3']);
});

test('a made id that another feature has gets -generated until no feature has it, as autk-db does', () => {
    // c, at 2, and e, at 4, have no id; the other features already have the ids they would be given.
    const features = [row('a', { id: 'autk-feature-2' }), row('b', { id: 'autk-feature-2-generated' }), row('c'), row('d', { id: 'autk-feature-4' }), row('e')];
    assert.deepEqual(featureIds(features), [
        'autk-feature-2', 'autk-feature-2-generated', 'autk-feature-2-generated-generated', 'autk-feature-4', 'autk-feature-4-generated',
    ]);
});

test('row keys tell the id 3 from the id "3", and name a repeated id by the times it came before', () => {
    assert.deepEqual(rowKeys([row('a', { id: 3 }), row('b', { id: '3' }), row('c', { id: 3 }), row('d', { id: 3 })]), ['3', '"3"', '3 1', '3 2']);
});

test("a selection passes between a plot of the host's rows and a layer of autk-db's export by the rows each drew", () => {
    // The host hands five rows, c without a geometry. autk-db exports c first; the layer leaves it out.
    const host = ['a', 'b', 'c', 'd', 'e'].map((name) => row(name, { geometry: name !== 'c' }));
    const plot = rowKeys(host);
    const layer = layerKeys(exportOf(host, [2, 0, 1, 3, 4]));
    assert.equal(layer.length, 4);
    // d and e, at 3 and 4 in the plot, are drawn at 2 and 3 on the layer.
    assert.deepEqual(translateIds([3, 4], plot, layer), [2, 3]);
    assert.deepEqual(translateIds([2, 3], layer, plot), [3, 4]);
    // c has no position on the layer.
    assert.deepEqual(translateIds([2], plot, layer), []);
    assert.deepEqual(translateIds([0, 2], plot, layer), [0]);
});

test('a selection passes by rows in any order the export keeps them', () => {
    const host = ['a', 'b', 'c', 'd'].map((name) => row(name));
    const plot = rowKeys(host);
    const layer = layerKeys(exportOf(host, [3, 1, 0, 2]));
    assert.deepEqual(translateIds([0], plot, layer), [2]);
    assert.deepEqual(translateIds([0, 1], layer, plot), [3, 1]);
});

test("rows keep their own ids, and the export's rows are found by them", () => {
    const host = [row('a', { id: 'n1' }), row('b', { id: 'n2' }), row('c', { id: 'n3', geometry: false })];
    const plot = rowKeys(host);
    const layer = layerKeys(exportOf(host, [2, 1, 0]));
    assert.deepEqual(translateIds([0, 1], plot, layer), [1, 0]);
});

test('a row drawn at several positions is lit at each, and is found from any of them', () => {
    const plot = rowKeys([row('a'), row('b')]);
    const layer = [plot[0], plot[1], plot[1]];
    assert.deepEqual(translateIds([1], plot, layer), [1, 2]);
    assert.deepEqual(translateIds([2], layer, plot), [1]);
    assert.deepEqual(translateIds([1, 2], layer, plot), [1]);
});

test('positions that name no row are left out', () => {
    const keys = rowKeys([row('a'), row('b')]);
    assert.deepEqual(translateIds([5, -1], keys, keys), []);
    assert.deepEqual(translateIds([0], keys, []), []);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
