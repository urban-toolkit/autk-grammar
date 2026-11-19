// Unit tests for what a plot spec's keys set of autk-plot's config, and what a run refuses of them before it draws a
// view. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import type { PlotSpec } from '@urban-toolkit/the-urban-grammar';
import { checkPlotKeys, checkPlotSelection, plotOptions } from '../../adapters/autk/src/plot-options.ts';

/** A plot spec with the fields given, a bar chart of `t` colored by `v` unless they say otherwise. */
const plot = (fields: Record<string, unknown> = {}) =>
    ({ id: 'p', dataRef: 't', mark: 'bar', axis: ['name', 'v'], color: 'v', ...fields }) as unknown as PlotSpec;

/** Asserts that a run refuses the plot with this sentence. */
function refused(fields: Record<string, unknown>, message: string) {
    assert.throws(() => checkPlotKeys(plot(fields)), { message: `Plot "p": ${message}` });
}

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

/** Rows of `t`: a name and a number `v` each, and a `kind` that is a category. */
const rows = [
    { type: 'Feature', geometry: null, properties: { name: 'a', v: 0, kind: 'oak' } },
    { type: 'Feature', geometry: null, properties: { name: 'b', v: 10, kind: 'elm' } },
    { type: 'Feature', geometry: null, properties: { name: 'c', v: 20, kind: 'oak' } },
] as unknown as Parameters<typeof plotOptions>[1];

test('a plot without the color keys leaves autk-plot its own schemes and domain', () => {
    const options = plotOptions(plot(), rows);
    assert.equal('colorMapInterpolator' in options, false);
    assert.equal('categoricalColorMapInterpolator' in options, false);
    assert.equal('domainSpec' in options, false);
    checkPlotKeys(plot());
});

test('hands autk-plot the scheme of numbers and the scheme of categories, each in its own key', () => {
    const options = plotOptions(plot({ colorMapInterpolator: 'interpolateViridis', categoricalColorMapInterpolator: 'schemeSet1' }), rows);
    assert.equal(options.colorMapInterpolator, 'interpolateViridis');
    assert.equal(options.categoricalColorMapInterpolator, 'schemeSet1');
    checkPlotKeys(plot({ colorMapInterpolator: 'interpolateRdBu', categoricalColorMapInterpolator: 'schemeTableau10' }));
});

test('refuses a scheme of the other kind, or a name that is not a scheme, naming the plot', () => {
    refused({ colorMapInterpolator: 'schemeSet1' },
        'colorMapInterpolator "schemeSet1" is a categorical scheme: numbers take an interpolate* scheme, and categories take categoricalColorMapInterpolator.');
    refused({ categoricalColorMapInterpolator: 'interpolateBlues' },
        'categoricalColorMapInterpolator "interpolateBlues" is not a categorical scheme: categories take a scheme* scheme, such as schemeTableau10.');
    refused({ colorMapInterpolator: 'rainbow' }, 'colorMapInterpolator "rainbow" is not a color scheme.');
    refused({ categoricalColorMapInterpolator: 3 }, 'categoricalColorMapInterpolator 3 is not a color scheme.');
    // A plot without an id is named by its table.
    assert.throws(() => checkPlotKeys(plot({ id: undefined, colorMapInterpolator: 'rainbow' })),
        { message: 'Plot "t": colorMapInterpolator "rainbow" is not a color scheme.' });
});

test('sets the ends of a scale of numbers to colorMapRange, which a plot colored by categories ignores', () => {
    const domainOf = (fields: Record<string, unknown>, of = rows) => plotOptions(plot(fields), of).domainSpec;
    assert.deepEqual(domainOf({ colorMapRange: [0, 50] }), { type: 'user', params: [0, 50] });
    // A heat matrix's cells hold counts or sums, and strings that read as numbers are numbers.
    assert.deepEqual(domainOf({ mark: 'heatmatrix', color: '@transform', colorMapRange: [0, 50] }), { type: 'user', params: [0, 50] });
    const strings = [{ type: 'Feature', geometry: null, properties: { w: '10' } }, { type: 'Feature', geometry: null, properties: { w: null } }];
    assert.deepEqual(domainOf({ color: 'w', colorMapRange: [0, 50] }, strings as unknown as typeof rows), { type: 'user', params: [0, 50] });
    // autk-core would read the range as the only categories, '0' and '50', and draw every kind in the mark color.
    assert.equal(domainOf({ color: 'kind', colorMapRange: [0, 50] }), undefined);
    // So does parallel coordinates' color column; without one, the range goes to autk-plot as it is.
    assert.deepEqual(domainOf({ mark: 'parallel-coordinates', color: undefined, colorMapRange: [0, 50] }), { type: 'user', params: [0, 50] });
});

test("finds the domain by colorMapDomain's categories or normalization's percentiles, as a map layer does", () => {
    const domainOf = (fields: Record<string, unknown>) => plotOptions(plot(fields), rows).domainSpec;
    assert.deepEqual(domainOf({ colorMapDomain: ['10', '20'] }), { type: 'user', params: ['10', '20'] });
    assert.deepEqual(domainOf({ normalization: { mode: 'percentile', lowerPercentile: 25, upperPercentile: 75 } }), { type: 'percentile', params: [25, 75] });
    assert.deepEqual(domainOf({ normalization: { mode: 'percentile', lowerPercentile: 10 } }), { type: 'percentile', params: [10, 100] });
    assert.deepEqual(domainOf({ normalization: { mode: 'percentile' } }), { type: 'percentile' });
    assert.deepEqual(domainOf({ normalization: { mode: 'minMax' } }), { type: 'minMax' });
    // An empty colorMapDomain names no category, as on a layer.
    assert.deepEqual(domainOf({ colorMapDomain: [], normalization: { mode: 'percentile' } }), { type: 'percentile' });
});

test('refuses a colorMapRange that is not [low, high] with low below high, or one set with colorMapDomain', () => {
    const shape = 'colorMapRange must hold two numbers, [low, high].';
    refused({ colorMapRange: [0] }, shape);
    refused({ colorMapRange: [0, 10, 20] }, shape);
    refused({ colorMapRange: [0, '10'] }, shape);
    refused({ colorMapRange: { low: 0, high: 10 } }, shape);
    refused({ colorMapRange: [10, 0] }, 'colorMapRange low (10) must be less than high (0).');
    refused({ colorMapRange: [5, 5] }, 'colorMapRange low (5) must be less than high (5).');
    refused({ colorMapRange: [0, 10], colorMapDomain: ['0', '10'] }, 'set colorMapRange or colorMapDomain, not both.');
    checkPlotKeys(plot({ colorMapRange: [-10, 10] }));
});

test('hands autk-plot the tick formats of the x and y axes, as d3-format reads them', () => {
    assert.deepEqual(plotOptions(plot({ tickFormats: ['.2f', '.0%'] }), rows).tickFormats, ['.2f', '.0%']);
    assert.equal('tickFormats' in plotOptions(plot(), rows), false);
    for (const tickFormats of [['', ''], ['~s', ',d'], ['$,.2f', '+.1e'], ['>8.3~s', '(,.0f'], ['x^10', '#x'], ['.0%', '08.2f']])
        checkPlotKeys(plot({ tickFormats }));
});

test('refuses tick formats that are not two specifiers d3-format reads', () => {
    const two = 'tickFormats must hold two d3-format specifiers, [x, y].';
    refused({ tickFormats: ['~s'] }, two);
    refused({ tickFormats: ['~s', '~s', '~s'] }, two);
    refused({ tickFormats: '~s' }, two);
    const unread = (at: number, format: string) => `tickFormats[${at}] ${format} is not a d3-format specifier, such as "~s", ",d" or ".0%".`;
    refused({ tickFormats: ['~s', '%%'] }, unread(1, '"%%"'));
    refused({ tickFormats: ['dollars', '~s'] }, unread(0, '"dollars"'));
    refused({ tickFormats: [2, '~s'] }, unread(0, '2'));
});

test("titles the axes with axisLabels, an axis without one by its column, and a transform's output value", () => {
    const labels = (fields: Record<string, unknown>) => plotOptions(plot(fields), rows).labels;
    assert.deepEqual(labels({}), { axis: ['name', 'v'], title: undefined });
    assert.deepEqual(labels({ axisLabels: ['Name', 'Value'], title: 'Trees' }), { axis: ['Name', 'Value'], title: 'Trees' });
    // A table titles its columns by the list it is handed, so every column gets one.
    assert.deepEqual(labels({ mark: 'table', axis: ['name', 'v', 'kind'], axisLabels: ['Name'] }), { axis: ['Name', 'v', 'kind'], title: undefined });
    // autk-plot titled the output of a binned bar chart or a line chart "@transform".
    assert.deepEqual(labels({ axis: ['v', '@transform'], transform: { preset: 'binning-1d' } }), { axis: ['v', 'value'], title: undefined });
    assert.deepEqual(labels({ axis: ['v', '@transform'], axisLabels: ['', 'Trees'] }), { axis: ['', 'Trees'], title: undefined });
    checkPlotKeys(plot({ axisLabels: [] }));
});

test('refuses axis titles that are not strings, more titles than axis columns, or two titles alike', () => {
    const list = 'axisLabels must be a list of titles, one for each column of axis.';
    refused({ axisLabels: 'Name' }, list);
    refused({ axisLabels: ['Name', 3] }, list);
    refused({ axisLabels: ['Name', 'Value', 'Kind'] }, 'axisLabels has 3 titles for the 2 columns of axis.');
    refused({ axisLabels: ['Value', 'Value'] }, 'axisLabels gives two axes the title "Value".');
});

test('refuses a selection that is not positions of rows, whole numbers from 0, or that names a row past the last', () => {
    const positions = 'selection must list the positions of rows, whole numbers from 0.';
    refused({ selection: [-1] }, positions);
    refused({ selection: [1.5] }, positions);
    refused({ selection: ['1'] }, positions);
    refused({ selection: 1 }, positions);
    for (const selection of [[], [0], [2, 0, 2]]) checkPlotKeys(plot({ selection }));

    checkPlotSelection(plot({ selection: [0, 2] }), 3);
    checkPlotSelection(plot(), 0);
    assert.throws(() => checkPlotSelection(plot({ selection: [0, 3] }), 3), { message: 'Plot "p": selection names row 3, but the plot draws 3 rows.' });
    assert.throws(() => checkPlotSelection(plot({ selection: [1] }), 1), { message: 'Plot "p": selection names row 1, but the plot draws 1 row.' });
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
