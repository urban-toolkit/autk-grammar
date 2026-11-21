import { ComputeSpec, DataSourceSpec, UrbanSpec } from "./types";

/** The entries of a spec's `data`, by the phase they run in. */
export type DataPhases = {
    /** The sources without `after`, which run before the compute passes, in the order of `data`. */
    before: DataSourceSpec[],
    /** The sources with `after: 'compute'`, which run once every compute pass has run, in the order of `data`. */
    after: DataSourceSpec[],
};

/** The tables a source reads by name, which a compute pass may write: a `sql` source's query is not read. */
function tablesRead(source: DataSourceSpec): string[] {
    switch (source.type) {
        case 'join': return [source.dataRef, source.joinDataRef];
        case 'heatmap': return [source.joinDataRef];
        case 'update':
        case 'drop': return [source.dataRef];
        default: return [];
    }
}

/** The table a compute pass writes: its `outputTableName`, else, for a GPGPU or clusters pass, its `dataRef`. */
function tableWritten(pass: ComputeSpec): string {
    return pass.outputTableName ?? (pass as { dataRef: string }).dataRef;
}

/**
 * The last of `passes` that writes the table `table` of the workspace `workspace`, by its place in `compute`, or -1 when
 * none does. A pass reads a table an earlier pass wrote from the grammar's cache, so its result holds the earlier
 * passes' columns, and a pass with `writeBack` keeps each row of its result whole: what autk-db holds of a table once
 * the passes have run is what its last pass kept there.
 */
function lastWriter(passes: ComputeSpec[], workspace: string | undefined, table: string): number {
    for (let index = passes.length - 1; index >= 0; index--) {
        const pass = passes[index];
        if ((pass.workspace ?? null) === (workspace ?? null) && tableWritten(pass) === table) return index;
    }
    return -1;
}

/**
 * Splits a spec's `data` into the two phases the engine runs it in: `before` the compute passes, and `after` them, each
 * in the order of `data`. A host that runs a spec's phases itself, such as one that loads the data on a server and runs
 * the passes in a browser, splits the sources with it, as the engine does.
 *
 * It refuses an `after` other than `'compute'`, and a source after compute that reads a table whose last compute pass
 * of its workspace writes it without `writeBack`: autk-db then holds that table without that pass's result.
 */
export function dataPhases(spec: UrbanSpec): DataPhases {
    const phases: DataPhases = { before: [], after: [] };
    const passes = spec.compute ?? [];
    (spec.data ?? []).forEach((source, index) => {
        const phase: unknown = (source as { after?: unknown }).after;
        if (phase === undefined) {
            phases.before.push(source);
            return;
        }
        if (phase !== 'compute')
            throw new Error(`Data source ${index} (${source.type}): after must be 'compute', the one phase a source runs after, not ${JSON.stringify(phase)}.`);
        for (const table of tablesRead(source)) {
            const writer = lastWriter(passes, source.workspace, table);
            if (writer >= 0 && passes[writer].writeBack !== true)
                throw new Error(`Data source ${index} (${source.type}) runs after compute and reads "${table}", which compute pass ${writer} writes without writeBack, so autk-db holds "${table}" without that pass's result. Set writeBack: true on the pass.`);
        }
        phases.after.push(source);
    });
    return phases;
}
