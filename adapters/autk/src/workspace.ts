import { AutkDb, DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';
import type { FeatureCollection } from 'geojson';

/**
 * Makes `workspace` (the default one without a name) the workspace `db` works in; autk-db creates it on first use.
 * It calls autk-db's `setWorkspace` only when `getCurrentWorkspace()` names another one.
 *
 * Every adapter calls it before it reads or writes a table of a spec entry, with the entry's `workspace`. A host that
 * reads a spec's tables itself calls it the same way, since autk-db finds a table by its name in the current
 * workspace only.
 */
export async function enterWorkspace(db: AutkDb, workspace?: string): Promise<void> {
    const name = workspace ?? DEFAULT_WORKSPACE_NAME;
    if (db.getCurrentWorkspace() !== name) await db.setWorkspace(name);
}

/**
 * The key a table has in the grammar's caches: its name in the default workspace, `<workspace>/<name>` in another, so
 * two workspaces can hold tables of the same name. A host reads the caches it passes to `createDataAdapter` and
 * `createComputeAdapter` with it.
 */
export function tableKey(workspace: string | undefined, name: string): string {
    return workspace === undefined || workspace === DEFAULT_WORKSPACE_NAME ? name : `${workspace}/${name}`;
}

/**
 * The CRS of the coordinates of each collection a GeoJSON source put in a cache: the source's own. The package's two
 * entries, the main one and `./data`, are built apart, each with a copy of this module, so the notes live in one map
 * that both copies find on the page under one global key: a compute adapter from one entry reads the notes of a data
 * adapter from the other.
 */
const SOURCE_CRS = Symbol.for('@urban-toolkit/autk-grammar:source-crs');
const pageWide = globalThis as unknown as Record<symbol, WeakMap<FeatureCollection, string> | undefined>;
const sourceCrs = (pageWide[SOURCE_CRS] ??= new WeakMap<FeatureCollection, string>());

/**
 * Notes that a GeoJSON source put `collection` in a cache as it gave it, with its coordinates in `crs`, its
 * `coordinateFormat`, which autk-db transforms to its workspace's CRS as it loads the source.
 */
export function noteSourceCrs(collection: FeatureCollection, crs: string): void {
    sourceCrs.set(collection, crs);
}

/**
 * `collection` when a GeoJSON source put it in a cache with its coordinates in `workspaceCrs`, the CRS autk-db keeps its
 * workspace in, else `undefined`: a compute pass compares a `fromFeature` table's coordinates with its own table's,
 * which autk-db keeps in the workspace's CRS.
 */
export function inWorkspaceCrs(collection: FeatureCollection | undefined, workspaceCrs: string): FeatureCollection | undefined {
    const crs = collection && sourceCrs.get(collection);
    return crs !== undefined && crs.toUpperCase() === workspaceCrs.toUpperCase() ? collection : undefined;
}
