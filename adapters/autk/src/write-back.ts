import { isVectorTable } from '@urban-toolkit/autk-db';
import type { AutkDb } from '@urban-toolkit/autk-db';
import type { LayerType } from '@urban-toolkit/the-urban-grammar';
import type { FeatureCollection } from 'geojson';

/** The query that creates the table a new result is written into: a geometry and properties, as autk-db's layers hold them, and no row. */
export const EMPTY_LAYER_QUERY = 'SELECT CAST(NULL AS GEOMETRY) AS geometry, CAST(NULL AS JSON) AS properties WHERE false';

/** A table's name as SQL quotes an identifier. */
function quoted(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Keeps a compute pass's result in autk-db, in the database's current workspace, which is the pass's: in place of the
 * table `name` when `inPlace` and autk-db holds that table as a layer, else as a new table `name` of the layer type
 * `type`. `label` names the pass in a refusal.
 *
 * - **In place**, autk-db's `updateTable` changes each row the result names by its feature id (the `geojson_id` column,
 *   else `id`), as the rows of autk-db's own export carry them. Every column of the table stays, a building keeps its
 *   parts, and autk-db clears the records of an OSM table's elements, as it does for any update.
 * - **A new table** is created empty (`rawQuery`), then filled with every row (`updateTable` replacing its rows), with the
 *   coordinates as they are, in the workspace's CRS. autk-db cuts each source it loads to the workspace's extent and
 *   crop layer, which would drop rows a pass placed outside them, such as the windows of a building that reaches past
 *   them; in autk-db 4.1.1 neither of these two calls cuts a table.
 * - Either way autk-db puts each coordinate on the workspace's precision grid. Then the table must hold as many rows as
 *   the result: a different count is refused, since autk-db's copy and the one maps and plots draw would differ.
 */
export async function writeBack(
    db: AutkDb, label: string, name: string, result: FeatureCollection, type: LayerType | undefined, inPlace: boolean,
): Promise<void> {
    const refuse = (message: string) => new Error(`${label}: ${message}`);
    if (type === 'raster')
        throw refuse(`writeBack keeps a table of features in autk-db, and "${name}" is a raster.`);
    const table = db.getTablesMetadata().find((candidate) => candidate.name === name);
    const update = inPlace && table !== undefined && isVectorTable(table);
    if (!update && type === undefined)
        throw refuse(`writeBack keeps "${name}" in autk-db as a layer, and the grammar knows no layer type for it: set the pass's layerType.`);
    try {
        if (update) {
            const idColumn = table.columns.some((column) => column.name === 'geojson_id') ? 'geojson_id' : 'id';
            await db.updateTable({ tableName: name, data: result, strategy: 'update', idColumn });
        } else {
            await db.rawQuery({ query: EMPTY_LAYER_QUERY, output: { type: 'CREATE_TABLE', tableName: name, source: 'user', tableType: type } });
            await db.updateTable({ tableName: name, data: result, strategy: 'replace' });
        }
    } catch (error) {
        throw refuse(`autk-db could not keep "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
    const counted = await db.rawQuery({ query: `SELECT count(*) AS n FROM ${quoted(name)}`, output: { type: 'RETURN_OBJECT' } }) as Array<{ n: unknown }>;
    const rows = Number(counted[0]?.n);
    if (rows !== result.features.length)
        throw refuse(`autk-db holds ${rows} rows of "${name}" where the pass wrote ${result.features.length}, so its table and the one maps and plots draw would differ.`);
}
