import { AutkDb, DEFAULT_WORKSPACE_NAME } from '@urban-toolkit/autk-db';

/** Makes `workspace` (the default one without a name) the workspace `db` works in; autk-db creates it on first use. */
export async function enterWorkspace(db: AutkDb, workspace?: string): Promise<void> {
    const name = workspace ?? DEFAULT_WORKSPACE_NAME;
    if (db.getCurrentWorkspace() !== name) await db.setWorkspace(name);
}

/**
 * The key a table has in the grammar's caches: its name in the default workspace, `<workspace>/<name>` in another, so
 * two workspaces can hold tables of the same name.
 */
export function tableKey(workspace: string | undefined, name: string): string {
    return workspace === undefined || workspace === DEFAULT_WORKSPACE_NAME ? name : `${workspace}/${name}`;
}
