// Unit tests for AutkGrammar's options, `wrapComputeAdapter` and `wrapDataAdapter`: a host's own adapters around the
// grammar's, which every run of the grammar calls instead. A fake autk-db stands for the database a host's data adapter
// hands the grammar's own, and records each call; a run with no data source runs its passes on no database. Each case
// checks that the grammar called the wrap function before it runs anything. The browser tests run the options on autk-db
// itself. The last case compiles a host's code with TypeScript against the package's built declarations, as a host
// compiles it, so it needs `make build` first, as CI runs it. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';
import type { AutkDb } from '@urban-toolkit/autk-db';
import type { FeatureCollection, Polygon } from 'geojson';
import type { ClustersComputeSpec, ComputeAdapter, ComputeSpec, DataAdapter, DataSourceSpec } from '@urban-toolkit/the-urban-grammar';
import { AutkGrammar } from '../../adapters/autk/src/main.ts';
import type { AutkGrammarOptions } from '../../adapters/autk/src/types.ts';

/** A call the grammar's adapters made of the database: the method's name, then its arguments. */
type Call = [method: string, ...args: unknown[]];

const square = (x: number): Polygon => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]]] });
/** Three squares: the first two share an edge, so a clusters pass puts them in cluster 0, and the third in cluster 1. */
const squares: FeatureCollection = {
    type: 'FeatureCollection',
    features: [0, 10, 100].map((x, i) => ({ type: 'Feature', id: `autk-feature-${i}`, properties: { i }, geometry: square(x) })),
};

/** A fake AutkDb holding the layers `layers`, which records each call the grammar's adapters make of it. */
function fakeDb(layers: Record<string, FeatureCollection> = {}): { db: AutkDb; calls: Call[] } {
    const calls: Call[] = [];
    let workspace = DEFAULT_WORKSPACE_NAME;
    const tables = () => Object.keys(layers).map((name) => ({ name, type: 'polygons', source: 'geojson', columns: [] }));
    const db = {
        getCurrentWorkspace: () => workspace,
        setWorkspace: async (name: string, ...rest: unknown[]) => { calls.push(['setWorkspace', name, ...rest]); workspace = name; },
        getWorkspaceConfiguration: () => ({ coordinateFormat: 'EPSG:3395' }),
        getTablesMetadata: tables,
        getLayersMetadata: tables,
        getLayer: async (name: string) => {
            calls.push(['getLayer', name]);
            if (!layers[name]) throw new Error(`Table ${name} not found.`);
            return layers[name];
        },
        loadCsv: async (params: unknown) => { calls.push(['loadCsv', params]); },
        loadGeojson: async (params: { outputTableName: string }) => { calls.push(['loadGeojson', params.outputTableName]); },
        getBoundingBoxFromLayer: async () => ({ minLon: 0, minLat: 0, maxLon: 110, maxLat: 10 }),
    };
    return { db: db as unknown as AutkDb, calls };
}

/** What a host's adapters saw: each call of the wrap functions, the adapter each was given, then each step of a run. */
type Seen = { wrapped: string[]; given: Array<ComputeAdapter | Required<DataAdapter>>; steps: string[]; contexts: unknown[] };

/** How a step names its entry: its type, then the table it writes. */
const named = (entry: { type?: string; outputTableName?: string; dataRef?: string }) =>
    `${entry.type ?? 'gpgpu'} ${entry.outputTableName ?? entry.dataRef}`;

/**
 * Options whose adapters record each step of a run, then hand it to the grammar's own adapter: the data adapter hands
 * it `db` where it is given no database, as a host that keeps the run's database does. `kinds` names the options made.
 */
function recording(db: AutkDb | undefined, kinds: Array<'data' | 'compute'>): { options: AutkGrammarOptions; seen: Seen } {
    const seen: Seen = { wrapped: [], given: [], steps: [], contexts: [] };
    const options: AutkGrammarOptions = {};
    if (kinds.includes('data')) options.wrapDataAdapter = (adapter) => {
        seen.wrapped.push('data');
        seen.given.push(adapter);
        return {
            ...adapter,
            async resolveWorkspaces(context, workspaces) {
                seen.steps.push('workspaces');
                return adapter.resolveWorkspaces(context ?? db, workspaces);
            },
            async resolveSource(context, source) {
                seen.steps.push(`source ${named(source as { type?: string; outputTableName?: string; dataRef?: string })}`);
                return adapter.resolveSource(context ?? db, source);
            },
        };
    };
    if (kinds.includes('compute')) options.wrapComputeAdapter = (adapter) => {
        seen.wrapped.push('compute');
        seen.given.push(adapter);
        return {
            async resolveCompute(context, pass) {
                seen.steps.push(`pass ${named(pass)}`);
                seen.contexts.push(context);
                return adapter.resolveCompute(context, pass);
            },
        };
    };
    return { options, seen };
}

const clusters = (dataRef: string, fields: Partial<ClustersComputeSpec> = {}): ClustersComputeSpec =>
    ({ type: 'clusters', dataRef, outputColumnName: 'block', ...fields });
const csv = (name: string, fields: object = {}): DataSourceSpec =>
    ({ type: 'csv', outputTableName: name, csvFileUrl: `${name}.csv`, ...fields }) as DataSourceSpec;

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("wrapComputeAdapter: every pass of every run goes through the host's compute adapter, which runs the grammar's own", async () => {
    const { options, seen } = recording(undefined, ['compute']);
    const grammar = new AutkGrammar(undefined, options);
    // Called once, as the grammar is made, with the grammar's own compute adapter.
    assert.deepEqual(seen.wrapped, ['compute']);
    assert.equal(typeof (seen.given[0] as ComputeAdapter).resolveCompute, 'function');

    // A run with no data source runs its passes on no database: each reaches the host's adapter, in order.
    await grammar.run({ compute: [clusters('squares'), clusters('squares', { outputTableName: 'blocks' })] });
    assert.deepEqual(seen.steps, ['clusters squares', 'clusters blocks'].map((step) => `pass ${step}`));
    // A second run goes through the same adapter: the function is not called again.
    await grammar.run({ compute: [clusters('lots')] });
    assert.deepEqual(seen.wrapped, ['compute']);
    assert.equal(seen.steps.at(-1), 'pass clusters lots');
    // The host's adapter hands each pass to the grammar's own, which refuses a pass of an unknown type.
    await assert.rejects(grammar.run({ compute: [{ type: 'nope', dataRef: 'squares' } as unknown as ComputeSpec] }), {
        message: 'Unknown compute pass type "nope".',
    });
    assert.equal(seen.steps.at(-1), 'pass nope squares');
});

test("wrapDataAdapter: a run's workspaces and every source, before compute and after, go through the host's data adapter", async () => {
    const { db, calls } = fakeDb();
    const { options, seen } = recording(db, ['data']);
    const grammar = new AutkGrammar(undefined, options);
    // Called once, as the grammar is made, with the grammar's own data adapter.
    assert.deepEqual(seen.wrapped, ['data']);
    const given = seen.given[0] as Required<DataAdapter>;
    assert.deepEqual([typeof given.resolveSource, typeof given.resolveWorkspaces], ['function', 'function']);

    await grammar.run({
        workspaces: [{ coordinateFormat: 'EPSG:3857', precisionGrid: 1 }],
        data: [csv('late', { after: 'compute' }), csv('sales'), csv('stores')],
    });
    // In the order the engine runs them: the workspaces, the sources before compute in the order of data, then those after.
    assert.deepEqual(seen.steps, ['workspaces', 'source csv sales', 'source csv stores', 'source csv late']);
    // The grammar's own adapter ran each of them, on the database the host's adapter handed it.
    assert.deepEqual(calls, [
        ['setWorkspace', DEFAULT_WORKSPACE_NAME, { coordinateFormat: 'EPSG:3857', precisionGrid: 1 }],
        ...['sales', 'stores', 'late'].map((name) => ['loadCsv', { outputTableName: name, csvFileUrl: `${name}.csv` }]),
    ]);
});

test("the run goes on with the database the host's data adapter returns, and a pass through the host's compute adapter lands in grammar.data", async () => {
    const { db, calls } = fakeDb({ squares });
    const { options, seen } = recording(db, ['data', 'compute']);
    const grammar = new AutkGrammar(undefined, options);
    assert.deepEqual([...seen.wrapped].sort(), ['compute', 'data']);

    await grammar.run({
        data: [{ type: 'geojson', outputTableName: 'squares', coordinateFormat: 'EPSG:3395', geojsonObject: squares }],
        compute: [clusters('squares', { outputTableName: 'blocks', layerType: 'polygons' })],
    });
    assert.deepEqual(seen.steps, ['source geojson squares', 'pass clusters blocks']);
    assert.deepEqual(calls.map(([method, name]) => `${method} ${name}`), ['loadGeojson squares', 'getLayer squares']);
    // The pass ran on the host's database, which the data adapter returned.
    assert.equal(seen.contexts[0], db);
    // The adapter the host was given is wired to the grammar's caches: grammar.data gives the pass's table, as maps and
    // plots read it, beside the database's own.
    assert.deepEqual(Object.keys(grammar.data).sort(), ['blocks', 'squares']);
    const blocks = await grammar.data.blocks;
    assert.deepEqual(blocks.features.map((feature) => feature.properties?.compute?.block), [0, 0, 1]);
});

test('a wrap function that returns no adapter of the shape it was given is refused as the grammar is made', () => {
    const refusedData = 'wrapDataAdapter must return a data adapter with resolveSource and resolveWorkspaces, as the one it is given has: { ...adapter, resolveSource } keeps its resolveWorkspaces.';
    const refusedCompute = 'wrapComputeAdapter must return a compute adapter with resolveCompute, as the one it is given has.';
    assert.throws(() => new AutkGrammar(undefined, { wrapDataAdapter: (adapter) => ({ resolveSource: adapter.resolveSource }) as never }), { message: refusedData });
    assert.throws(() => new AutkGrammar(undefined, { wrapDataAdapter: () => undefined as never }), { message: refusedData });
    assert.throws(() => new AutkGrammar(undefined, { wrapComputeAdapter: () => ({}) as never }), { message: refusedCompute });
    // The adapter it was given, returned as it is, is taken.
    assert.doesNotThrow(() => new AutkGrammar(undefined, { wrapDataAdapter: (adapter) => adapter, wrapComputeAdapter: (adapter) => adapter }));
});

/** A file of a host's that is never written: the compiler reads it from `compileAsAHost`, in the repository's tests. */
const HOST_FILE = fileURLToPath(new URL('./host.ts', import.meta.url));

/**
 * The messages TypeScript gives `code`, a module of a host's that imports `@urban-toolkit/autk-grammar`, compiled with
 * `strict`, as the grammar is, against the declarations the package ships (`adapters/autk/dist/index.d.ts`), which it
 * finds by the package's name, as a host does.
 */
function compileAsAHost(code: string): string[] {
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
        types: [],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
    };
    const host = ts.createCompilerHost(options);
    const { getSourceFile, fileExists, readFile } = host;
    host.getSourceFile = (name, version, ...rest) =>
        (name === HOST_FILE ? ts.createSourceFile(name, code, version) : getSourceFile.call(host, name, version, ...rest));
    host.fileExists = (name) => name === HOST_FILE || fileExists.call(host, name);
    host.readFile = (name) => (name === HOST_FILE ? code : readFile.call(host, name));
    const program = ts.createProgram([HOST_FILE], options, host);
    const file = program.getSourceFile(HOST_FILE);
    return [
        ...program.getOptionsDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...program.getSyntacticDiagnostics(file),
        ...program.getSemanticDiagnostics(file),
    ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

/**
 * A host's ways of writing `wrapDataAdapter` on 5.6.0: the README's example, both calls written out; the given adapter
 * spread, with its resolveSource replaced; the given adapter as it is; a wrapper generic over the adapter it is given, as
 * Curio's is; and a host that calls a wrap function and then both calls of what it returns.
 */
const HOST_CODE = `
import { AutkGrammar } from '@urban-toolkit/autk-grammar';
import type { AutkGrammarOptions, DataAdapter } from '@urban-toolkit/autk-grammar';

declare const db: unknown;
declare function handedTo<A extends DataAdapter>(adapter: A): A;

export const written = new AutkGrammar({ map: 'map' }, {
    wrapDataAdapter: (adapter) => ({
        resolveWorkspaces: (context, workspaces) => adapter.resolveWorkspaces(context ?? db, workspaces),
        resolveSource: (context, source) => adapter.resolveSource(context ?? db, source),
    }),
});
export const spread: AutkGrammarOptions = {
    wrapDataAdapter: (adapter) => ({ ...adapter, resolveSource: (context, source) => adapter.resolveSource(context ?? db, source) }),
};
export const same: AutkGrammarOptions = { wrapDataAdapter: (adapter) => adapter };
export const generic: AutkGrammarOptions = { wrapDataAdapter: (adapter) => handedTo(adapter) };
export async function calls(options: Required<AutkGrammarOptions>, given: Required<DataAdapter>): Promise<void> {
    const wrapped = options.wrapDataAdapter(given);
    await wrapped.resolveWorkspaces(undefined, []);
    await wrapped.resolveSource(undefined, { type: 'csv', outputTableName: 't', csvFileUrl: 't.csv' });
}
`;

/** A call a later 5.x adds to `DataAdapter`, optional, as `resolveWorkspaces` is. */
const LATER_CALL = `
declare module '@urban-toolkit/autk-grammar' {
    interface DataAdapter {
        resolveLater?(context: unknown): Promise<unknown>;
    }
}
`;

test("a host's wrapDataAdapter that compiles on 5.6.0 still compiles once DataAdapter gains an optional call, as a 5.x release may add", () => {
    // DataAdapter as it is: each way compiles.
    assert.deepEqual(compileAsAHost(HOST_CODE), []);
    // With a call added, the adapter a host returns still needs only resolveSource and resolveWorkspaces, which a run
    // makes and the grammar checks for as it is made: a host that wrote neither the new call nor a spread compiles too.
    assert.deepEqual(compileAsAHost(HOST_CODE + LATER_CALL), []);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
