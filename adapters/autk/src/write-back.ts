import { isVectorTable } from '@urban-toolkit/autk-db';
import type { AutkDb, Table } from '@urban-toolkit/autk-db';
import type { LayerType } from '@urban-toolkit/the-urban-grammar';
import type { FeatureCollection } from 'geojson';

/** The query that creates the table a new result is written into: a geometry and properties, as autk-db's layers hold them, and no row. */
export const EMPTY_LAYER_QUERY = 'SELECT CAST(NULL AS GEOMETRY) AS geometry, CAST(NULL AS JSON) AS properties WHERE false';

/**
 * The table a new table `name` is filled in before a copy of it takes the place of `name`. It is joined to `name` by an
 * underscore, so autk-db's check of a raw query, which refuses a query with a word such as `drop` or `update` in it,
 * takes the query that copies it.
 */
export function stagingTable(name: string): string {
    return `__autk_grammar_write_back_${name}`;
}

/**
 * The column autk-db's update by feature id matches the rows of the layer `table` on: the one its export gives each row
 * as its feature id, `geojson_id`, else `id`. That update sets each row's `properties`, so it cannot change a table that
 * keeps its values in columns of their own, without a `properties` column, such as a CSV or JSON layer or a `sql`
 * source's table of plain columns: undefined for such a table, and for one without either id column.
 */
export function updateIdColumn(table: Table): 'geojson_id' | 'id' | undefined {
    const columns = new Set(table.columns.map((column) => column.name));
    if (!columns.has('properties')) return undefined;
    if (columns.has('geojson_id')) return 'geojson_id';
    return columns.has('id') ? 'id' : undefined;
}

/** A table's name as SQL quotes an identifier. */
function quoted(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** The rows autk-db holds in the table `name` of its current workspace. */
async function rowCount(db: AutkDb, name: string): Promise<number> {
    const counted = await db.rawQuery({ query: `SELECT count(*) AS n FROM ${quoted(name)}`, output: { type: 'RETURN_OBJECT' } }) as Array<{ n: unknown }>;
    return Number(counted[0]?.n);
}

/**
 * Keeps a compute pass's result in autk-db, in the database's current workspace, which is the pass's: in place of the
 * table `name` when `inPlace` and autk-db holds that table as a layer, else as a new table `name` of the layer type
 * `type`. `label` names the pass in a refusal.
 *
 * - **In place**, autk-db's `updateTable` changes each row the result names by its feature id (the `geojson_id` column,
 *   else `id`), as the rows of autk-db's own export carry them. Every column of the table stays, a building keeps its
 *   parts, and autk-db clears the records of an OSM table's elements, as it does for any update. A table that update
 *   cannot change ({@link updateIdColumn}), such as a CSV or JSON layer, and a result with a row without a feature id,
 *   are written whole instead: `updateTable` replaces the table's rows with the result's, in one transaction, each
 *   row's values in its `properties`, as a GeoJSON layer keeps them, and the table keeps its layer type.
 * - **A new table** is filled aside first, in a table of its own ({@link stagingTable}): `rawQuery` creates it empty,
 *   and `updateTable` replaces its rows with every row of the result, with the coordinates as they are, in the
 *   workspace's CRS. Only once it holds them all does a copy of it take the place of `name`, in one statement, so a
 *   refusal leaves a table of that name as it was, and no table where there was none. autk-db cuts each source it loads
 *   to the workspace's extent and crop layer, which would drop rows a pass placed outside them, such as the windows of a
 *   building that reaches past them; in autk-db 4.1.1 none of these calls cuts a table.
 * - Either way autk-db puts each coordinate on the workspace's precision grid. The table must hold as many rows as the
 *   result, a new one counted before it takes the place of `name`: a different count is refused, since autk-db's copy
 *   and the one maps and plots draw would differ.
 */
export async function writeBack(
    db: AutkDb, label: string, name: string, result: FeatureCollection, type: LayerType | undefined, inPlace: boolean,
): Promise<void> {
    const refuse = (message: string) => new Error(`${label}: ${message}`);
    if (type === 'raster')
        throw refuse(`writeBack keeps a table of features in autk-db, and "${name}" is a raster.`);
    const table = db.getTablesMetadata().find((candidate) => candidate.name === name);
    const layer = inPlace && table !== undefined && isVectorTable(table) ? table : undefined;
    if (layer === undefined && type === undefined)
        throw refuse(`writeBack keeps "${name}" in autk-db as a layer, and the grammar knows no layer type for it: set the pass's layerType.`);

    /** Runs one of autk-db's writes, naming the pass and the table when autk-db refuses it. */
    const kept = async (write: () => Promise<unknown>): Promise<void> => {
        try {
            await write();
        } catch (error) {
            throw refuse(`autk-db could not keep "${name}": ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    /** Refuses the table `counted` when it does not hold as many rows as the result. */
    const holdsEveryRow = async (counted: string): Promise<void> => {
        const rows = await rowCount(db, counted);
        if (rows !== result.features.length)
            throw refuse(`autk-db holds ${rows} rows of "${name}" where the pass wrote ${result.features.length}, so its table and the one maps and plots draw would differ.`);
    };

    if (layer) {
        const idColumn = updateIdColumn(layer);
        const everyRowNamed = result.features.every((feature) => feature.id !== undefined && feature.id !== null);
        await kept(() => db.updateTable(idColumn !== undefined && everyRowNamed
            ? { tableName: name, data: result, strategy: 'update', idColumn }
            : { tableName: name, data: result, strategy: 'replace' }));
        await holdsEveryRow(name);
        return;
    }

    const staging = stagingTable(name);
    await kept(() => db.rawQuery({ query: EMPTY_LAYER_QUERY, output: { type: 'CREATE_TABLE', tableName: staging, source: 'user', tableType: type } }));
    try {
        await kept(() => db.updateTable({ tableName: staging, data: result, strategy: 'replace' }));
        await holdsEveryRow(staging);
        await kept(() => db.rawQuery({ query: `SELECT * FROM ${quoted(staging)}`, output: { type: 'CREATE_TABLE', tableName: name, source: 'user', tableType: type } }));
    } finally {
        // As autk-db drops its own staging tables: a failure to drop this one is let go, so it hides no refusal.
        await db.removeLayer(staging).catch(() => undefined);
    }
}
