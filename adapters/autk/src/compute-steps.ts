import type { ComputeAdapter, ComputeSpec, DataAdapter, DataSourceSpec, LayerType, WorkspaceName, WorkspaceSpec } from '@urban-toolkit/the-urban-grammar';
import type { AutkDb } from '@urban-toolkit/autk-db';
import type { FeatureCollection } from 'geojson';
import { createDataAdapter } from './adapters/data';
import { createComputeAdapter } from './adapters/compute';
import type { ComputeCache, ComputeLayerTypes, GeoJsonCache, Targets } from './types';
import { tableKey } from './workspace';

/**
 * The data adapter and the compute adapter of one run, sharing its caches: the data adapter puts each GeoJSON table in
 * `sources`, from which a compute pass reads a `fromFeature` table, and takes each table a source writes out of `cache`
 * and `types`, in which the compute adapter keeps each pass's result and the layer type of each table a pass wrote under
 * its own name. `AutkGrammar` wires its adapters with it, and so does {@link createComputeSteps}.
 */
export function wiredAdapters(
    targets: Targets | undefined, sources: GeoJsonCache, cache: ComputeCache, types: ComputeLayerTypes,
): { data: Required<DataAdapter>; compute: ComputeAdapter } {
    return {
        data: createDataAdapter(targets, sources, cache, types),
        compute: createComputeAdapter(cache, types, sources),
    };
}

/** A table as a compute pass left it, which {@link ComputeSteps.computed} gives. */
export interface ComputedTable {
    /** The pass's result: the collection itself, not a copy, which maps, plots and later passes read before autk-db's table. */
    collection: FeatureCollection;
    /**
     * How a map draws the table, for a table a pass wrote under its own `outputTableName`: the pass's `layerType`, else
     * `points` for a windows pass or a render pass with `building-windows`, else the type of the table it computed over.
     * Undefined for a table a pass changed in place, which a map draws as the type of autk-db's table of that name.
     */
    layerType?: LayerType;
}

/**
 * The steps of a run up to its maps and plots, on an autk-db database the host owns: a spec's `workspaces`, its data
 * sources and its compute passes, one call at a time, run as `AutkGrammar.run` runs them. Made by
 * {@link createComputeSteps}. Each call takes the host's database and returns it, and leaves the workspace of the entry it
 * ran current.
 */
export interface ComputeSteps {
    /** Sets up each workspace a spec's `workspaces` lists, as a run does before its first source, and leaves the default workspace current. */
    resolveWorkspaces(db: AutkDb, workspaces: WorkspaceSpec[]): Promise<AutkDb>;
    /**
     * Loads one entry of a spec's `data`, in the entry's workspace: a source before the passes, or one with
     * `after: 'compute'` once they have run. A table it writes leaves {@link computed}: from then on, autk-db's table is
     * the one maps and plots read.
     */
    resolveSource(db: AutkDb, source: DataSourceSpec): Promise<AutkDb>;
    /**
     * Runs one entry of a spec's `compute`, in the pass's workspace, and keeps its result for {@link computed}, and in
     * the database too with `writeBack`. A later pass reads a table from the earlier passes' results first, and a
     * `fromFeature` table as a GeoJSON source of these steps gave it.
     */
    resolveCompute(db: AutkDb, pass: ComputeSpec): Promise<AutkDb>;
    /**
     * The table `name` of the workspace `workspace` (the default one without a name), as a pass left it: what maps,
     * plots and later passes read before autk-db's table. Undefined when no pass wrote the table, or a source wrote it
     * since: autk-db's table is then the one they read.
     */
    computed(name: string, workspace?: WorkspaceName): ComputedTable | undefined;
}

/** `db`, when the host gave one; else a refusal, before anything runs, since the adapters would make a database of their own or run no pass. */
function hostDb(db: AutkDb | undefined, step: string): AutkDb {
    if (!db) throw new Error(`${step}: the steps run on an autk-db database the host owns, and none was given.`);
    return db;
}

/**
 * The steps of a run up to its maps and plots, for a host that runs them on an autk-db database it owns, with no map or
 * plot, and reads the tables the run leaves: each pass's result as the grammar holds it ({@link ComputeSteps.computed}),
 * and every other table from its database. The steps share their adapters and caches as `AutkGrammar` shares its own:
 * a pass reads a `fromFeature` table as a GeoJSON source gave it, keeps its result with `writeBack` in the host's
 * database, and a source after compute reads what passes kept there and takes each table it writes out of the passes'
 * results.
 *
 * A host calls the steps in the order a run takes, `resolveWorkspaces` first, then the sources of
 * `dataPhases(spec).before`, each pass of `compute`, then the sources of `dataPhases(spec).after`, and can do work of its
 * own between them, such as a check around each pass. One set of steps runs one spec: a new run takes new steps.
 *
 * @example
 * const db = new AutkDb();
 * await db.init();
 * const steps = createComputeSteps();
 * const { before, after } = dataPhases(spec);
 * if (spec.workspaces) await steps.resolveWorkspaces(db, spec.workspaces);
 * for (const source of before) await steps.resolveSource(db, source);
 * for (const pass of spec.compute ?? []) await steps.resolveCompute(db, pass);
 * for (const source of after) await steps.resolveSource(db, source);
 * const blocks = steps.computed('blocks')?.collection;
 */
export function createComputeSteps(): ComputeSteps {
    const sources: GeoJsonCache = new Map();
    const cache: ComputeCache = new Map();
    const types: ComputeLayerTypes = new Map();
    const { data, compute } = wiredAdapters(undefined, sources, cache, types);
    return {
        async resolveWorkspaces(db: AutkDb, workspaces: WorkspaceSpec[]): Promise<AutkDb> {
            await data.resolveWorkspaces(hostDb(db, 'resolveWorkspaces'), workspaces);
            return db;
        },
        async resolveSource(db: AutkDb, source: DataSourceSpec): Promise<AutkDb> {
            await data.resolveSource(hostDb(db, 'resolveSource'), source);
            return db;
        },
        async resolveCompute(db: AutkDb, pass: ComputeSpec): Promise<AutkDb> {
            await compute.resolveCompute(hostDb(db, 'resolveCompute'), pass);
            return db;
        },
        computed(name: string, workspace?: WorkspaceName): ComputedTable | undefined {
            const key = tableKey(workspace, name);
            const collection = cache.get(key);
            if (!collection) return undefined;
            const layerType = types.get(key);
            return layerType === undefined ? { collection } : { collection, layerType };
        },
    };
}
