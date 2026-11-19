import { DataSourceSpec, WorkspaceSpec } from "../types";

export interface DataAdapter {
    resolveSource(context: unknown, spec: DataSourceSpec): Promise<unknown>;
    /**
     * Sets up the workspaces a spec's `workspaces` lists, before its first source loads, and returns the context. An
     * adapter without workspaces leaves it out, and the engine then skips `workspaces`.
     */
    resolveWorkspaces?(context: unknown, workspaces: WorkspaceSpec[]): Promise<unknown>;
}