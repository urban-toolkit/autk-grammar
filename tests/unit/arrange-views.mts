// Unit tests for arrangeViews, which gives each view of a spec its pane on the page as the spec's `layout` says, so
// every host arranges a spec's views alike. Run after `make build` (the last test reads the built main entry):
//   npm run test:unit
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { arrangeViews } from '../../grammar/src/layout.ts';
import type { MapSpec, PlotSpec, UrbanSpec } from '../../grammar/src/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const adapterDir = join(root, 'adapters', 'autk');

// The gallery's specs, by example name: the hub arranges each one's views with arrangeViews.
const examplesDir = join(root, 'gallery', 'src', 'examples');
const gallery = new Map<string, UrbanSpec>();
for (const file of readdirSync(examplesDir).filter((name) => name.endsWith('.ts'))) {
    const module = await import(pathToFileURL(join(examplesDir, file)).href);
    if ('spec' in module) gallery.set(file.replace(/\.ts$/, ''), module.spec as UrbanSpec);
}

const map = (id?: string): MapSpec => ({ ...(id !== undefined && { id }), layerRefs: [{ dataRef: 'zones' }] });
const plot = (dataRef: string, id?: string): PlotSpec => ({ ...(id !== undefined && { id }), dataRef, mark: 'scatter', axis: ['a', 'b'] });

/** The places of the panes, as `kind index key row,column`. */
function places(spec: UrbanSpec): string[] {
    return arrangeViews(spec).panes.map((pane) => `${pane.kind} ${pane.index} ${pane.key} ${pane.row},${pane.column}`);
}

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test('without a layout, the panes stack: the maps in order, then the plots, 0 pixels apart', () => {
    const spec: UrbanSpec = { map: [map(), map('after')], plot: [plot('zones'), plot('zones', 'heights')] };
    const { type, rows, columns, gap, panes } = arrangeViews(spec);
    assert.deepEqual({ type, rows, columns, gap }, { type: 'vertical', rows: 4, columns: 1, gap: 0 });
    assert.deepEqual(panes, [
        { kind: 'map', index: 0, key: 0, row: 0, column: 0 },
        { kind: 'map', index: 1, id: 'after', key: 'after', row: 1, column: 0 },
        { kind: 'plot', index: 0, key: 'zones', row: 2, column: 0 },
        { kind: 'plot', index: 1, id: 'heights', key: 'heights', row: 3, column: 0 },
    ]);
});

test('a key is the view id, else a map index or a plot dataRef, as the events name the view', () => {
    assert.deepEqual(places({ map: map(), plot: plot('zones') }), ['map 0 0 0,0', 'plot 0 zones 1,0']);
    assert.deepEqual(places({ map: map('city'), plot: plot('zones', 'sizes') }), ['map 0 city 0,0', 'plot 0 sizes 1,0']);
});

test('vertical stacks the panes, as no layout does', () => {
    const spec: UrbanSpec = { map: map(), plot: plot('zones') };
    assert.deepEqual(places({ ...spec, layout: { type: 'vertical' } }), places(spec));
    assert.deepEqual(places({ ...spec, layout: {} }), places(spec));
});

test('horizontal puts the panes side by side, one column each', () => {
    const { rows, columns, gap } = arrangeViews({ layout: { type: 'horizontal', gap: 8 }, map: [map(), map()], plot: plot('zones') });
    assert.deepEqual({ rows, columns, gap }, { rows: 1, columns: 3, gap: 8 });
    assert.deepEqual(places({ layout: { type: 'horizontal' }, map: [map(), map()], plot: plot('zones') }), ['map 0 0 0,0', 'map 1 1 0,1', 'plot 0 zones 0,2']);
});

test('grid fills its columns row by row, 2 by default', () => {
    const spec: UrbanSpec = { map: [map(), map('right')], plot: plot('zones') };
    const twoColumns = arrangeViews({ ...spec, layout: { type: 'grid' } });
    assert.deepEqual({ rows: twoColumns.rows, columns: twoColumns.columns }, { rows: 2, columns: 2 });
    assert.deepEqual(places({ ...spec, layout: { type: 'grid' } }), ['map 0 0 0,0', 'map 1 right 0,1', 'plot 0 zones 1,0']);
    const threeColumns = { map: [map(), map(), map(), map()], plot: plot('zones'), layout: { type: 'grid' as const, columns: 3, gap: 4 } };
    assert.deepEqual(places(threeColumns), ['map 0 0 0,0', 'map 1 1 0,1', 'map 2 2 0,2', 'map 3 3 1,0', 'plot 0 zones 1,1']);
    const { rows, columns, gap } = arrangeViews(threeColumns);
    assert.deepEqual({ rows, columns, gap }, { rows: 2, columns: 3, gap: 4 });
});

test('columns are read by a grid only', () => {
    const spec: UrbanSpec = { map: [map(), map()], layout: { type: 'horizontal', columns: 5 } };
    assert.deepEqual(arrangeViews(spec).columns, 2);
});

test('a spec without views has no panes', () => {
    assert.deepEqual(arrangeViews({ data: [] }), { type: 'vertical', rows: 0, columns: 1, gap: 0, panes: [] });
    assert.deepEqual(arrangeViews({ layout: { type: 'horizontal' } }).panes, []);
});

test('refuses a layout it cannot arrange, and names the value', () => {
    const refused = (layout: unknown, message: string) =>
        assert.throws(() => arrangeViews({ map: map(), layout } as UrbanSpec), { message });
    refused({ type: 'diagonal' }, 'Layout type must be vertical, horizontal or grid, not "diagonal".');
    refused({ gap: -1 }, 'Layout gap must be a number of pixels, 0 or more, not -1.');
    refused({ gap: '8' }, 'Layout gap must be a number of pixels, 0 or more, not "8".');
    refused({ type: 'grid', columns: 0 }, 'Layout columns must be a whole number, 1 or more, not 0.');
    refused({ type: 'grid', columns: 2.5 }, 'Layout columns must be a whole number, 1 or more, not 2.5.');
    refused({ type: 'grid', columns: '3' }, 'Layout columns must be a whole number, 1 or more, not "3".');
});

test("every gallery example arranges, and the examples of two maps, and interaction-external's map and plot, stand side by side", () => {
    assert.ok(gallery.size > 50, `${gallery.size} gallery specs`);
    for (const spec of gallery.values()) arrangeViews(spec);
    for (const name of ['multi-map', 'osm-layers-api-multi', 'workspaces', 'interaction-external', 'linked-views']) {
        const { type, rows, panes } = arrangeViews(gallery.get(name)!);
        assert.deepEqual({ type, rows, panes: panes.length }, { type: 'horizontal', rows: 1, panes: 2 }, name);
    }
    // Every other example of two maps stands side by side too.
    for (const [name, spec] of gallery) {
        if (Array.isArray(spec.map) && spec.map.length > 1) assert.equal(arrangeViews(spec).type, 'horizontal', name);
    }
});

test('the main entry exports arrangeViews and its types', () => {
    const types = readFileSync(join(adapterDir, 'dist', 'index.d.ts'), 'utf8');
    assert.match(types, /export declare function arrangeViews\(spec: UrbanSpec\): ViewArrangement;/);
    assert.match(types, /export declare type ViewArrangement = \{|export type ViewArrangement = \{/);
    assert.match(types, /export declare type ViewPane = \{|export type ViewPane = \{/);
    const code = readFileSync(join(adapterDir, 'dist', 'autk-grammar.js'), 'utf8');
    assert.match(code, /export\s*\{[^}]*\barrangeViews\b[^}]*\}/);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
