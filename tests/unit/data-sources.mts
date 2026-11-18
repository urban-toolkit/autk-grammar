// Unit tests for the data adapter's sources, with a fake autk-db that records every call the adapter makes: what each
// entry of a spec's `data` asks autk-db to do, and what the adapter refuses before autk-db runs. They load the built
// `./data` entry, which a host's server calls. Run after `make build`:
//   npm run test:unit
import assert from 'node:assert/strict';
import { DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';
import type { AutkDb } from '@urban-toolkit/autk-db';
import { createDataAdapter } from '@urban-toolkit/autk-grammar/data';
import type { DataSourceSpec } from '@urban-toolkit/autk-grammar/data';

/** A call the adapter made: the method's name, then its arguments. */
type Call = [method: string, ...args: unknown[]];

/** A table the fake database holds, as autk-db's metadata gives it. */
type FakeTable = { name: string; type?: string };

/**
 * A fake AutkDb that records the calls the adapter makes and holds the tables `tables` lists. It starts in the default
 * workspace, as autk-db does after `init()`.
 */
function fakeDb(tables: FakeTable[] = []): { db: AutkDb; calls: Call[] } {
    const calls: Call[] = [];
    let current = DEFAULT_WORKSPACE_NAME;
    const recorded = (method: string) => async (...args: unknown[]) => { calls.push([method, ...args]); };
    const db = {
        getCurrentWorkspace: () => current,
        setWorkspace: async (name: string, ...rest: unknown[]) => { calls.push(['setWorkspace', name, ...rest]); current = name; },
        getTablesMetadata: () => tables,
        getLayer: async (name: string) => {
            calls.push(['getLayer', name]);
            return { type: 'FeatureCollection', features: [] };
        },
        loadOsm: recorded('loadOsm'),
        loadCsv: recorded('loadCsv'),
        loadJson: recorded('loadJson'),
        buildHeatmap: recorded('buildHeatmap'),
        rawQuery: recorded('rawQuery'),
        updateTable: recorded('updateTable'),
        removeLayer: recorded('removeLayer'),
    };
    return { db: db as unknown as AutkDb, calls };
}

/** Loads `source` into a fake database holding `tables`, and gives the calls the adapter made. */
async function callsFor(source: unknown, tables?: FakeTable[]): Promise<Call[]> {
    const { db, calls } = fakeDb(tables);
    await createDataAdapter().resolveSource(db, source as DataSourceSpec);
    return calls;
}

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('refuses a source of a type it does not know, rather than hand the next source a new database', async () => {
    const { db } = fakeDb();
    await assert.rejects(
        createDataAdapter().resolveSource(db, { type: 'shapefile', outputTableName: 't' } as unknown as DataSourceSpec),
        { message: 'Unknown data source type "shapefile".' },
    );
});

test('a CSV source still loads into the database it is given', async () => {
    const csv = { type: 'csv', outputTableName: 'c', csvFileUrl: 'rows.csv' };
    const { db, calls } = fakeDb();
    assert.equal(await createDataAdapter().resolveSource(db, csv as DataSourceSpec), db);
    assert.deepEqual(calls, [['loadCsv', { outputTableName: 'c', csvFileUrl: 'rows.csv' }]]);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${(error as Error).stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
