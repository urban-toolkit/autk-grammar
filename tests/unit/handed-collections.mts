// Unit tests for what a run handed each view, as AutkGrammar gives it: `mapLayers` and `mapLayer` give each layer with
// the collection the map adapter handed autk-map for it, and `plotCollection` the collection the plot adapter handed
// autk-plot for a plot. A map or a plot needs a page and a GPU, so the case puts in the grammar's registries what the
// adapters put there as a run draws (adapters/map.ts, adapters/plot.ts); the browser tests run the adapters themselves.
// Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import type { AutkMap } from '@urban-toolkit/autk-map';
import type { FeatureCollection } from 'geojson';
import { AutkGrammar } from '../../adapters/autk/src/main.ts';

/** A collection of the features named `names`, each a point, as a run hands one. */
const collection = (names: string[]): FeatureCollection => ({
    type: 'FeatureCollection',
    features: names.map((name, i) => ({ type: 'Feature', properties: { name }, geometry: { type: 'Point', coordinates: [i, 0] } })),
});

/** The registries a run's map and plot adapters fill as they hand their views the collections they draw. */
type Registries = {
    _layers: Array<{ map: AutkMap; mapIndex: number; mapId: string | number; layerId: string; dataRef: string; rows: string[]; collection: FeatureCollection }>;
    _plotCollections: Map<string, FeatureCollection>;
};

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('mapLayers gives each layer with the collection the run handed it, plotCollection a plot\'s, and destroy() lets them go', () => {
    const grammar = new AutkGrammar();
    // Before a run, no view was handed anything.
    assert.equal(grammar.plotCollection('chart'), undefined);
    assert.deepEqual(grammar.mapLayers('spots'), []);

    // Two maps draw the spots, each from the collection its layer was handed; a plot of them, from its own.
    const registries = grammar as unknown as Registries;
    const [before, after] = [{} as AutkMap, {} as AutkMap];
    const [handedBefore, handedAfter, handedPlot] = [collection(['a', 'b']), collection(['a', 'b', 'd']), collection(['a', 'b', 'c', 'd'])];
    registries._layers.push(
        { map: before, mapIndex: 0, mapId: 'before', layerId: 'Spots', dataRef: 'spots', rows: ['0', '1'], collection: handedBefore },
        { map: after, mapIndex: 1, mapId: 1, layerId: 'spots', dataRef: 'spots', rows: ['0', '1', '3'], collection: handedAfter },
    );
    registries._plotCollections.set('chart', handedPlot);

    assert.deepEqual(grammar.mapLayers('spots'), [
        { map: before, layerId: 'Spots', collection: handedBefore },
        { map: after, layerId: 'spots', collection: handedAfter },
    ]);
    // Each is the collection itself, by the map's id or its index, and the last map's without one.
    assert.equal(grammar.mapLayer('spots', 'before')?.collection, handedBefore);
    assert.equal(grammar.mapLayer('spots', 1)?.collection, handedAfter);
    assert.equal(grammar.mapLayer('spots')?.collection, handedAfter);
    assert.equal(grammar.plotCollection('chart'), handedPlot);
    assert.equal(grammar.plotCollection('spots'), undefined);

    // destroy(), which a run calls first, lets the last run's views go.
    grammar.destroy();
    assert.deepEqual(grammar.mapLayers('spots'), []);
    assert.equal(grammar.plotCollection('chart'), undefined);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
