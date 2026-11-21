// Unit tests for the two phases of a spec's `data`: the sources before the compute passes and those with
// `after: 'compute'`, which `dataPhases` splits and the engine runs in that order, and the sources after compute it
// refuses. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import { DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';
import type { ComputeSpec, DataSourceSpec, UrbanSpec } from '../../grammar/src/types.ts';
import { dataPhases } from '../../grammar/src/phases.ts';
import { createEngine } from '../../grammar/src/main.ts';
import { createDataAdapter as createDeckGlDataAdapter } from '../../adapters/deckgl/src/adapters/data.ts';

const csv = (name: string, fields: object = {}) => ({ type: 'csv', outputTableName: name, csvFileUrl: `${name}.csv`, ...fields }) as DataSourceSpec;
const join = (dataRef: string, joinDataRef: string, fields: object = {}) => ({ type: 'join', dataRef, joinDataRef, ...fields }) as DataSourceSpec;
const after = { after: 'compute' };
const clusters = (dataRef: string, fields: object = {}) =>
    ({ type: 'clusters', dataRef, outputColumnName: 'cluster', ...fields }) as ComputeSpec;
const windows = (dataRef: string, outputTableName: string, fields: object = {}) =>
    ({ type: 'windows', dataRef, floors: 2, outputTableName, ...fields }) as ComputeSpec;

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('splits the sources by phase, each phase in the order of data', () => {
    const data = [csv('a'), join('blocks', 'pins', after), csv('b'), csv('c', after)];
    const { before, after: later } = dataPhases({ data });
    assert.deepEqual(before, [data[0], data[2]]);
    assert.deepEqual(later, [data[1], data[3]]);
    assert.deepEqual(dataPhases({}), { before: [], after: [] });
});

test("refuses an after other than 'compute', naming the source", () => {
    assert.throws(() => dataPhases({ data: [csv('a'), csv('b', { after: 'map' })] }), {
        message: `Data source 1 (csv): after must be 'compute', the one phase a source runs after, not "map".`,
    });
    assert.throws(() => dataPhases({ data: [csv('b', { after: true })] }), /after must be 'compute'.*not true\.$/);
});

test('refuses a source after compute that reads a table a pass writes without writeBack, naming both', () => {
    const refused = (spec: UrbanSpec, message: RegExp | string) => assert.throws(() => dataPhases(spec), typeof message === 'string' ? { message } : message);
    // A pass in place, and a join into its table.
    refused({ data: [csv('blocks'), join('blocks', 'pins', after)], compute: [clusters('blocks')] },
        'Data source 1 (join) runs after compute and reads "blocks", which compute pass 0 writes without writeBack, so autk-db holds "blocks" without that pass\'s result. Set writeBack: true on the pass.');
    // A new table, joined onto another, built into a heatmap, updated and dropped.
    const w = windows('buildings', 'w');
    refused({ data: [join('blocks', 'w', after)], compute: [w] }, /reads "w", which compute pass 0 writes without writeBack/);
    refused({ data: [{ type: 'heatmap', outputTableName: 'h', joinDataRef: 'w', near: { distance: 1 }, grid: { rows: 1, columns: 1 }, ...after } as DataSourceSpec], compute: [w] }, /Data source 0 \(heatmap\)/);
    refused({ data: [{ type: 'update', dataRef: 'w', strategy: 'replace', jsonObject: [{}], ...after } as DataSourceSpec], compute: [w] }, /Data source 0 \(update\)/);
    refused({ data: [{ type: 'drop', dataRef: 'w', ...after } as DataSourceSpec], compute: [w] }, /Data source 0 \(drop\)/);
    // A later pass that writes the table again without writeBack, after one with it.
    refused({ data: [join('blocks', 'pins', after)], compute: [clusters('blocks', { writeBack: true }), clusters('blocks', { outputColumnName: 'again' })] },
        /which compute pass 1 writes without writeBack/);
});

test('takes a source after compute that reads what passes kept in autk-db, or a table no pass of its workspace writes', () => {
    const takes = (spec: UrbanSpec) => assert.equal(dataPhases(spec).after.length, (spec.data ?? []).filter((s) => (s as { after?: string }).after).length);
    takes({ data: [join('blocks', 'pins', after)], compute: [clusters('blocks', { writeBack: true })] });
    takes({ data: [join('blocks', 'w', after)], compute: [windows('buildings', 'w', { writeBack: true })] });
    // A pass of another workspace writes a table of the same name.
    takes({ data: [join('blocks', 'pins', after)], compute: [clusters('blocks', { workspace: 'west' })] });
    // A table the pass only reads, and a sql source, whose query is not read.
    takes({ data: [join('buildings', 'pins', after)], compute: [windows('buildings', 'w')] });
    takes({ data: [{ type: 'sql', outputTableName: 's', query: 'SELECT * FROM blocks', ...after } as DataSourceSpec], compute: [clusters('blocks')] });
    // A source before compute reads the table as it was loaded, as before.
    takes({ data: [csv('blocks'), join('blocks', 'pins')], compute: [clusters('blocks')] });
});

test("takes a source after compute that reads a table whose last pass writes it with writeBack, which keeps the earlier passes' columns", () => {
    // Passes chain through the grammar's cache, and a write-back in place sets each row's properties whole, so the last
    // pass that writes a table decides what autk-db holds.
    const takes = (spec: UrbanSpec) => assert.deepEqual(dataPhases(spec).after, (spec.data ?? []).filter((source) => (source as { after?: string }).after));
    // A GPGPU pass in place without writeBack, then a clusters pass in place with it, which reads the first's result: a
    // join after compute reads the first's column in autk-db.
    const shade = { dataRef: 'fidi_buildings', attributes: { h: 'height' }, outputColumnName: 'shade', wgslFunction: 'return h;' } as ComputeSpec;
    takes({
        data: [join('zones', 'fidi_buildings', { groupBy: [{ column: 'compute.shade', aggregateFn: 'avg' }], ...after })],
        compute: [shade, clusters('fidi_buildings', { outputColumnName: 'block', writeBack: true })],
    });
    // A new table a pass wrote without writeBack, then a pass in place over it with writeBack.
    takes({ data: [join('blocks', 'w', after)], compute: [windows('buildings', 'w'), clusters('w', { writeBack: true })] });
});

test("reads the default workspace by autk-db's name for it as the one an entry without a workspace is in, as a run does", () => {
    const refused = (spec: UrbanSpec) => assert.throws(() => dataPhases(spec), {
        message: 'Data source 1 (join) runs after compute and reads "squares", which compute pass 0 writes without writeBack, so autk-db holds "squares" without that pass\'s result. Set writeBack: true on the pass.',
    });
    // The pass names the default workspace, and the join after compute names none.
    refused({ data: [csv('squares'), join('squares', 'pins', after)], compute: [clusters('squares', { workspace: DEFAULT_WORKSPACE_NAME })] });
    // The join names it, and the pass names none.
    refused({ data: [csv('squares'), join('squares', 'pins', { ...after, workspace: DEFAULT_WORKSPACE_NAME })], compute: [clusters('squares')] });
});

test('the engine runs the sources before compute, then the passes, then the sources after compute, then maps and plots', async () => {
    const calls: string[] = [];
    const record = (what: string) => async (context: unknown, spec: { outputTableName?: string; dataRef?: string; type?: string }) => {
        calls.push(`${what} ${spec.outputTableName ?? spec.dataRef}`);
        return context;
    };
    const spec: UrbanSpec = {
        workspaces: [{ coordinateFormat: 'EPSG:3857', precisionGrid: 1 }],
        data: [join('blocks', 'pins', after), csv('blocks'), csv('pins'), csv('late', after)],
        compute: [clusters('blocks', { writeBack: true })],
        map: { layerRefs: [{ dataRef: 'blocks' }] },
        plot: { dataRef: 'late', mark: 'table', axis: ['a', 'b'] },
    };
    const engine = createEngine({
        spec,
        adapters: {
            db: { resolveSource: record('source'), resolveWorkspaces: async (context: unknown) => { calls.push('workspaces'); return context; } },
            compute: { resolveCompute: record('pass') },
            map: { resolveMap: async () => { calls.push('map'); } },
            plot: { resolvePlot: async () => { calls.push('plot'); } },
        } as never,
    });
    await engine.run();
    assert.deepEqual(calls, ['workspaces', 'source blocks', 'source pins', 'pass blocks', 'source blocks', 'source late', 'map', 'plot']);

    // A refused source stops the run before any adapter runs.
    calls.length = 0;
    const refused = createEngine({
        spec: { ...spec, compute: [clusters('blocks')] },
        adapters: {
            db: { resolveSource: record('source'), resolveWorkspaces: async (context: unknown) => { calls.push('workspaces'); return context; } },
            compute: { resolveCompute: record('pass') },
            map: { resolveMap: async () => { calls.push('map'); } },
            plot: { resolvePlot: async () => { calls.push('plot'); } },
        } as never,
    });
    await assert.rejects(refused.run(), /Data source 0 \(join\) runs after compute and reads "blocks"/);
    assert.deepEqual(calls, []);
});

test('the deck.gl adapter refuses a source after compute, since it runs no compute pass', async () => {
    await assert.rejects(createDeckGlDataAdapter().resolveSource(undefined, csv('a', after)), {
        message: 'csv data source: after is read by the Autark adapter only; the deck.gl adapter runs no compute pass for a source to come after.',
    });
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
