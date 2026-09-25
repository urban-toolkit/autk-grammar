// Unit tests for the compute helpers, with a fake GPU runner. Run after `make build`:
//   npm run test:unit
import assert from 'node:assert/strict';
import type { FeatureCollection } from 'geojson';
import type { ComputeSpec } from '@urban-toolkit/the-urban-grammar';
import {
    MAX_BATCHED_FEATURES, buildBatchedUniforms, computeLayerNames, findIterateSource, joinWgsl,
    resolveComputeParams, runCompute,
} from '../../adapters/autk/src/compute-params.ts';

const fc = (props: Array<Record<string, unknown>>, rings?: number[][][]): FeatureCollection => ({
    type: 'FeatureCollection',
    features: props.map((p, i) => ({
        type: 'Feature',
        properties: p,
        geometry: rings ? { type: 'Polygon', coordinates: [rings[i]] } : { type: 'Point', coordinates: [0, 0] },
    })),
});

const base: ComputeSpec = { dataRef: 'roads', attributes: { x: 'lanes' }, outputColumnName: 'out', wglsFunction: 'return x;' };
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('joinWgsl joins lines with newlines', () => {
    assert.equal(joinWgsl(['let a = 1; // one', 'return a;']), 'let a = 1; // one\nreturn a;');
    assert.equal(joinWgsl('return 1;'), 'return 1;');
});

test('plain pass maps spec fields to dispatch params', () => {
    const roads = fc([{ lanes: 2 }]);
    const p = resolveComputeParams({ ...base, wglsFunction: ['a', 'b'], uniforms: { k: 3 } }, { roads });
    assert.equal(p.collection, roads);
    assert.equal(p.wgslBody, 'a\nb');
    assert.equal(p.resultField, 'out');
    assert.deepEqual(p.uniforms, { k: 3 });
});

test('missing dataRef throws', () => {
    assert.throws(() => resolveComputeParams(base, {}), /roads/);
});

test('fromFeature reads index 0 by default, coerces numbers, and falls back to default', () => {
    const sun = fc([{ az: '135' }, { az: 90 }]);
    const p = resolveComputeParams({
        ...base,
        uniforms: {
            az: { fromFeature: { layer: 'sun', path: 'properties.az' } },
            second: { fromFeature: { layer: 'sun', path: 'properties.az', index: 1 } },
            missing: { fromFeature: { layer: 'sun', path: 'properties.nope' }, default: 7 },
            dropped: { fromFeature: { layer: 'sun', path: 'properties.nope' } },
        },
    }, { roads: fc([{}]), sun });
    assert.deepEqual(p.uniforms, { az: 135, second: 90, missing: 7 });
});

test('fromFeature matrix entry becomes { data, cols }', () => {
    const ring = [[0, 0], [2, 0], [2, 1], [0, 0]];
    const p = resolveComputeParams({
        ...base,
        uniformMatrices: { outline: { fromFeature: { layer: 'b', path: 'geometry.coordinates.0' }, cols: 2 } },
    }, { roads: fc([{}]), b: fc([{}], [ring]) });
    assert.deepEqual(p.uniformMatrices, { outline: { data: ring, cols: 2 } });
});

test('computeLayerNames and findIterateSource read every directive', () => {
    const spec: ComputeSpec = {
        ...base,
        uniforms: { h: { fromFeature: { layer: 'bldg', path: 'properties.h', iterate: 'batched' } } },
        uniformMatrices: { o: { fromFeature: { layer: 'bldg', path: 'geometry.coordinates.0', iterate: 'batched' }, cols: 2 } },
    };
    assert.deepEqual(computeLayerNames(spec), ['roads', 'bldg']);
    assert.deepEqual(findIterateSource(spec), { mode: 'batched', layer: 'bldg' });
    assert.equal(findIterateSource(base), null);
});

test('batched packs values and bounding boxes, drops features missing required paths', () => {
    const bldg = fc(
        [{ h: 10 }, { h: null }, { h: 30 }],
        [[[0, 0], [4, 0], [4, 2]], [[9, 9], [9, 9], [9, 9]], [[-1, -1], [1, -1], [1, 3]]],
    );
    const packed = buildBatchedUniforms(
        { h: { fromFeature: { layer: 'bldg', path: 'properties.h', iterate: 'batched', required: true } }, doy: 172 },
        { o: { fromFeature: { layer: 'bldg', path: 'geometry.coordinates.0', iterate: 'batched' }, cols: 2 } },
        bldg.features,
    );
    assert.deepEqual(packed.uniforms, { doy: 172, num_features: 2 });
    assert.deepEqual(packed.uniformArrays.h, [10, 30]);
    assert.deepEqual(packed.uniformArrays.o, [0, 0, 4, 0, 4, 2, 0, 2, -1, -1, 1, -1, 1, 3, -1, 3]);
});

test('batched caps the feature count', () => {
    const many = fc(Array.from({ length: MAX_BATCHED_FEATURES + 5 }, (_, i) => ({ v: i })));
    const packed = buildBatchedUniforms({ v: { fromFeature: { layer: 'm', path: 'properties.v', iterate: 'batched' } } }, undefined, many.features);
    assert.equal(packed.uniforms.num_features, MAX_BATCHED_FEATURES);
    assert.equal(packed.uniformArrays.v.length, MAX_BATCHED_FEATURES);
});

test('batched pass produces one dispatch with packed arrays and no matrices', async () => {
    const calls: unknown[] = [];
    const roads = fc([{ lanes: 1 }]);
    const spec: ComputeSpec = { ...base, uniforms: { h: { fromFeature: { layer: 'bldg', path: 'properties.h', iterate: 'batched' } } } };
    await runCompute(spec, { roads, bldg: fc([{ h: 5 }, { h: 6 }]) }, async (p) => { calls.push(p); return p.collection; });
    assert.equal(calls.length, 1);
    const p = calls[0] as { uniforms: Record<string, number>; uniformArrays: Record<string, number[]>; uniformMatrices?: unknown };
    assert.deepEqual(p.uniformArrays.h, [5, 6]);
    assert.equal(p.uniforms.num_features, 2);
    assert.equal(p.uniformMatrices, undefined);
});

test("iterate 'all' dispatches once per feature and sums the outputs", async () => {
    const roads = fc([{ lanes: 1 }, { lanes: 2 }]);
    const sun = fc([{ w: 1 }, { w: 10 }, { w: 100 }]);
    const spec: ComputeSpec = { ...base, uniforms: { w: { fromFeature: { layer: 'sun', path: 'properties.w', iterate: 'all' } } } };
    const seen: number[] = [];
    const out = await runCompute(spec, { roads, sun }, async (p) => {
        const w = p.uniforms!.w;
        seen.push(w);
        const copy = structuredClone(p.collection);
        copy.features.forEach((f, j) => { (f.properties as Record<string, unknown>).compute = { out: w * (j + 1) }; });
        return copy;
    });
    assert.deepEqual(seen, [1, 10, 100]);
    assert.deepEqual(out.features.map(f => (f.properties as { compute: { out: number } }).compute.out), [111, 222]);
    assert.equal((roads.features[0].properties as Record<string, unknown>).compute, undefined, 'input is not mutated');
});

test('batched pass keeps non-iterating directives and literal matrices', () => {
    const p = resolveComputeParams({
        ...base,
        uniforms: {
            h: { fromFeature: { layer: 'bldg', path: 'properties.h', iterate: 'batched' } },
            alt: { fromFeature: { layer: 'sun', path: 'properties.alt' } },
            doy: 172,
        },
        uniformMatrices: {
            rot: { data: [[1, 0], [0, 1]], cols: 2 },
            o: { fromFeature: { layer: 'bldg', path: 'geometry.coordinates.0', iterate: 'batched' }, cols: 2 },
        },
    }, { roads: fc([{}]), bldg: fc([{ h: 3 }], [[[0, 0], [1, 1]]]), sun: fc([{ alt: 40 }]) });
    assert.deepEqual(p.uniforms, { alt: 40, doy: 172, num_features: 1 });
    assert.deepEqual(p.uniformArrays?.h, [3]);
    assert.deepEqual(p.uniformMatrices, { rot: { data: [[1, 0], [0, 1]], cols: 2 } });
});

test('matrix cols default to the row width, and an unknown width drops the entry', () => {
    const ring = [[0, 0], [2, 0], [2, 1]];
    const p = resolveComputeParams({
        ...base,
        uniformMatrices: {
            outline: { fromFeature: { layer: 'b', path: 'geometry.coordinates.0' } },
            bogus: { fromFeature: { layer: 'b', path: 'properties.flat' } },
        },
    }, { roads: fc([{}]), b: fc([{ flat: [1, 2, 3] }], [ring]) });
    assert.deepEqual(p.uniformMatrices, { outline: { data: ring, cols: 2 } });
});

test('a missing fromFeature layer falls back to the default', () => {
    const p = resolveComputeParams({
        ...base,
        uniforms: { k: { fromFeature: { layer: 'absent', path: 'properties.k' }, default: 1 } },
    }, { roads: fc([{}]), absent: undefined });
    assert.deepEqual(p.uniforms, { k: 1 });
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}\n${(e as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
