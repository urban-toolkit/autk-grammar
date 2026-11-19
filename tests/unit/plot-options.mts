// Unit tests for what a plot spec's keys set of autk-plot's config, and what a run refuses of them before it draws a
// view. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import type { PlotSpec } from '@urban-toolkit/the-urban-grammar';
import { checkPlotKeys, plotOptions } from '../../adapters/autk/src/plot-options.ts';

/** A plot spec with the fields given, a bar chart of `t` colored by `v` unless they say otherwise. */
const plot = (fields: Record<string, unknown> = {}) =>
    ({ id: 'p', dataRef: 't', mark: 'bar', axis: ['name', 'v'], color: 'v', ...fields }) as unknown as PlotSpec;

/** Asserts that a run refuses the plot with this sentence. */
function refused(fields: Record<string, unknown>, message: string) {
    assert.throws(() => checkPlotKeys(plot(fields)), { message: `Plot "p": ${message}` });
}

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test('a plot without the color keys leaves autk-plot its own schemes', () => {
    const options = plotOptions(plot());
    assert.equal('colorMapInterpolator' in options, false);
    assert.equal('categoricalColorMapInterpolator' in options, false);
    checkPlotKeys(plot());
});

test('hands autk-plot the scheme of numbers and the scheme of categories, each in its own key', () => {
    const options = plotOptions(plot({ colorMapInterpolator: 'interpolateViridis', categoricalColorMapInterpolator: 'schemeSet1' }));
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

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
