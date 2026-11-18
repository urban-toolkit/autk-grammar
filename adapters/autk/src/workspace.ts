import { AutkDb, DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';

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
