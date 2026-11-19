// Unit tests for the CRS of a collection a GeoJSON source put in the cache, which a compute pass checks before it
// reads a `fromFeature` table from the cache: the pass compares its coordinates with its own table's, which autk-db
// keeps in the workspace's CRS. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import type { FeatureCollection } from 'geojson';
import { inWorkspaceCrs, noteSourceCrs } from '../../adapters/autk/src/workspace.ts';

const collection = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test("reads a source's collection whose coordinates are in the workspace's CRS, whatever the CRS name's case", () => {
    const parts = collection();
    noteSourceCrs(parts, 'EPSG:3395');
    assert.equal(inWorkspaceCrs(parts, 'EPSG:3395'), parts);
    assert.equal(inWorkspaceCrs(parts, 'epsg:3395'), parts);
});

test("does not read a source's collection in another CRS, such as EPSG:4326 degrees in a World Mercator workspace", () => {
    const parts = collection();
    noteSourceCrs(parts, 'EPSG:4326');
    assert.equal(inWorkspaceCrs(parts, 'EPSG:3395'), undefined);
    assert.equal(inWorkspaceCrs(parts, 'EPSG:4326'), parts);
});

test('does not read a collection no source noted, such as a table a join wrote, nor a missing one', () => {
    assert.equal(inWorkspaceCrs(collection(), 'EPSG:3395'), undefined);
    assert.equal(inWorkspaceCrs(undefined, 'EPSG:3395'), undefined);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
