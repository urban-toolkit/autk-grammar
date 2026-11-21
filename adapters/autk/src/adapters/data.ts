import { CsvDataSourceSpec, CustomDataSourceSpec, DataAdapter, DataSourceSpec, DropSourceSpec, GeoTiffDataSourceSpec, HeatmapSourceSpec, JoinSourceSpec, JsonDataSourceSpec, OsmDataSourceSpec, SqlSourceSpec, UpdateSourceSpec, WorkspaceSpec } from '@urban-toolkit/the-urban-grammar';
import { AutkDb, DEFAULT_WORKSPACE_NAME, isRenderableTable, isVectorTable } from '@urban-toolkit/autk-db';
import type { LoadGeojsonParams, Table } from '@urban-toolkit/autk-db';
import type { FeatureCollection, Geometry } from 'geojson';
import { Targets, GeoJsonCache, ComputeCache, ComputeLayerTypes } from '../types';
import { enterWorkspace, noteSourceCrs, tableKey } from '../workspace';
import { featureIds } from '../rows';

/** An empty geometry: a GeometryCollection with none in it, which a map draws as nothing. */
const NO_GEOMETRY: Geometry = { type: 'GeometryCollection', geometries: [] };

/**
 * A GeoJSON source's collection as autk-db loads it, row for row.
 *
 * - Each feature carries the id autk-db gives it (see `featureIds`), from its place in the source. autk-db keeps the
 *   id in its export, so a row a map draws from the export is found among the source's own rows, which a plot draws.
 * - autk-db refuses a feature whose geometry is null, which GeoJSON allows, so such a feature gets an empty one: a map
 *   draws nothing for it, and a plot still counts it.
 * - autk-db reads the layer's type off the first feature, so a first feature without a geometry trades places with the
 *   first that has one. Each keeps its id, so the rows are still found by it.
 */
function loadableCollection(collection: FeatureCollection): FeatureCollection {
    const features = collection.features ?? [];
    const ids = featureIds(features);
    let changed = false;
    const loadable = features.map((feature, index) => {
        if (feature == null || (feature.id != null && feature.geometry != null)) return feature;
        changed = true;
        return { ...feature, id: ids[index], geometry: feature.geometry ?? NO_GEOMETRY };
    });
    const first = features.findIndex((feature) => feature?.geometry != null);
    if (first > 0 && features[0] != null && features[0].geometry == null) {
        [loadable[0], loadable[first]] = [loadable[first], loadable[0]];
        changed = true;
    }
    return changed ? { ...collection, features: loadable } : collection;
}

/**
 * The query area autk-db reads: `{ bbox }` or `{ geocodeArea, areas }`. autk-db takes any area with a
 * `bbox` key as a box, so a box that also names areas, or that is not [west, south, east, north] in
 * degrees with west less than east and south less than north, is refused here.
 */
function queryAreaOf(spec: OsmDataSourceSpec): OsmDataSourceSpec['queryArea'] {
    const { queryArea } = spec;
    if (queryArea.bbox === undefined) return { geocodeArea: queryArea.geocodeArea, areas: queryArea.areas };

    const refuse = (message: string) => new Error(`OSM source "${spec.outputTableName}": ${message}`);
    if (queryArea.geocodeArea !== undefined || queryArea.areas !== undefined)
        throw refuse('queryArea takes either bbox or geocodeArea with areas, not both.');
    const box: unknown = queryArea.bbox;
    if (!Array.isArray(box) || box.length !== 4 || !box.every((value) => typeof value === 'number' && Number.isFinite(value)))
        throw refuse('queryArea.bbox must hold four numbers, [west, south, east, north] in degrees.');
    const [west, south, east, north] = queryArea.bbox;
    if (Math.abs(west) > 180 || Math.abs(east) > 180)
        throw refuse('queryArea.bbox west and east must be longitudes from -180 to 180.');
    if (Math.abs(south) > 90 || Math.abs(north) > 90)
        throw refuse('queryArea.bbox south and north must be latitudes from -90 to 90.');
    if (west >= east)
        throw refuse(`queryArea.bbox west (${west}) must be less than east (${east}); a box across the antimeridian is not supported.`);
    if (south >= north)
        throw refuse(`queryArea.bbox south (${south}) must be less than north (${north}).`);
    return { bbox: [west, south, east, north] };
}

/**
 * Maps an OSM source onto autk-db's parameters, which always expect `autoLoadLayers`, with the CRS of the source's
 * coordinates when it gives one, and no longer take `dropOsmTable`. autk-db reads `tagSets` from the Overpass API only,
 * so a source that also names a PBF extract is refused here, by its name.
 */
function toLoadOsmParams(spec: OsmDataSourceSpec) {
    const { autoLoadLayers, ...rest } = spec;
    if (spec.pbfFileUrl !== undefined && (spec.tagSets?.length ?? 0) > 0)
        throw new Error(`OSM source "${spec.outputTableName}": tagSets are read from the Overpass API only, so a source with pbfFileUrl cannot take them.`);
    return {
        ...rest,
        queryArea: queryAreaOf(spec),
        autoLoadLayers: {
            layers: autoLoadLayers?.layers ?? [],
            ...(autoLoadLayers?.coordinateFormat !== undefined && { coordinateFormat: autoLoadLayers.coordinateFormat }),
        },
    };
}

/**
 * The CRS advice. Only a bounding-box check gives it, when the box shows that a layer's coordinates
 * are not in the CRS it was loaded as; any other load error is autk-db's own message.
 */
function crsAdvice(coordinateFormat: string | undefined): string {
    const assumed = coordinateFormat
        ? `coordinateFormat is set to "${coordinateFormat}"`
        : 'no coordinateFormat was specified, so it defaults to EPSG:4326 (WGS84 per RFC 7946)';
    return `${assumed}. Verify that coordinateFormat matches the actual CRS of the input data.`;
}

/** How a message names a workspace: the default one, or another by its name. */
function workspaceLabel(name: string | undefined): string {
    return name === undefined || name === DEFAULT_WORKSPACE_NAME ? 'the default workspace' : `the workspace "${name}"`;
}

/** A feature property's value as SQL's `->>` reads it: a string as it is, any other value as its JSON. */
function propertyText(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The rows of an update of a layer keyed by a feature property, `properties.<name>`, keyed instead by the feature ids of
 * the table's rows they match. autk-db 4.1.1 matches such a key with `table.properties->>'name' =
 * staging.properties->>'name'`, which DuckDB reads so that the comparison is NULL: no row matches, and nothing is
 * updated. It matches a plain column as written. So each given feature goes to every row whose property has its value,
 * compared as text, as `->>` reads it, under that row's id in autk-db's export: its `geojson_id`, else its `id`.
 */
async function updateByFeatureId(db: AutkDb, table: Table, rows: FeatureCollection, property: string): Promise<{ data: FeatureCollection, idColumn: string }> {
    const ids = new Map<string, Array<string | number>>();
    for (const row of (await db.getLayer(table.name)).features) {
        const key = propertyText((row.properties as Record<string, unknown> | null)?.[property]);
        if (key === undefined) continue;
        if (row.id === undefined || row.id === null)
            throw new Error('its rows have no feature id to update them by.');
        ids.set(key, [...(ids.get(key) ?? []), row.id]);
    }
    const features = rows.features.flatMap((feature) => {
        const key = propertyText((feature.properties as Record<string, unknown> | null)?.[property]);
        return key === undefined ? [] : (ids.get(key) ?? []).map((id) => ({ ...feature, id }));
    });
    const idColumn = table.columns.some((column) => column.name === 'geojson_id') ? 'geojson_id' : 'id';
    return { data: { ...rows, features }, idColumn };
}

/**
 * The rows of an update of a table without a geometry, each with its keys in the order of the table's columns. autk-db
 * 4.1.1 stages the given rows with DuckDB's `read_json_auto`, whose columns follow a row's keys in the order they come,
 * then inserts them with `INSERT INTO <table> SELECT * FROM <staging>`, by position: a row given as `{ count, zone }` to
 * a table of (zone, count) wrote its count in zone. autk-db writes each given row as a whole row of the table, so a row
 * that lacks a column of the table, or has one the table does not have, is refused, by that key. autk-db lists every
 * column of a table it holds, so the rows of a table listed without any, as a host's stand-in database may list it, go
 * as they are given.
 */
function inColumnOrder(rows: Array<Record<string, unknown>>, table: Table): Array<Record<string, unknown>> {
    const columns = table.columns.map((column) => column.name);
    if (columns.length === 0) return rows;
    const listed = columns.map((column) => `"${column}"`).join(', ');
    return rows.map((row, index) => {
        const keys = Object.keys(row ?? {});
        const missing = columns.find((column) => !keys.includes(column));
        if (missing !== undefined)
            throw new Error(`jsonObject[${index}] has no "${missing}"; autk-db writes each given row as a whole row of the table, so it gives every column: ${listed}.`);
        const extra = keys.find((key) => !columns.includes(key));
        if (extra !== undefined)
            throw new Error(`jsonObject[${index}] has "${extra}", which is not a column of the table: ${listed}.`);
        return Object.fromEntries(columns.map((column) => [column, row[column]]));
    });
}

/**
 * Whether a table keeps each value in a column of its own, without the `properties` column a GeoJSON or an OSM layer
 * keeps its rows' values in. autk-db's update of a layer sets that column on each row it matches, so it cannot change a
 * layer of plain columns: a CSV or JSON layer, or a `sql` source's table of plain columns drawn as a layer. autk-db lists
 * every column of a table it holds, so a table listed without any, as a host's stand-in database may list it, is not
 * taken for one.
 */
function keepsPlainColumns(table: Table): boolean {
    return table.columns.length > 0 && !table.columns.some((column) => column.name === 'properties');
}

/** The database a source loads into: `context`, else a new one. */
async function database(context: AutkDb | undefined): Promise<AutkDb> {
    if (context) return context;
    const db = new AutkDb();
    await db.init();
    return db;
}

/** The [minX, minY, maxX, maxY] of every position in a collection, or undefined when it has none. */
export function extentOf(collection: FeatureCollection): [number, number, number, number] | undefined {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visitPositions = (value: unknown): void => {
        if (!Array.isArray(value)) return;
        if (typeof value[0] === 'number') {
            const [x, y] = value as number[];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            return;
        }
        for (const inner of value) visitPositions(inner);
    };
    const visitGeometry = (geometry: Geometry | null | undefined): void => {
        if (!geometry) return;
        if (geometry.type === 'GeometryCollection') geometry.geometries.forEach(visitGeometry);
        else visitPositions(geometry.coordinates);
    };
    for (const feature of collection.features ?? []) visitGeometry(feature?.geometry);
    return minX <= maxX ? [minX, minY, maxX, maxY] : undefined;
}

/** A copy of a source without the fields only the grammar reads, `workspace` and `after`, which autk-db would take for its own. */
function withoutGrammarFields(spec: DataSourceSpec): DataSourceSpec {
    const fields = { ...spec };
    delete fields.workspace;
    delete fields.after;
    return fields;
}

/**
 * The tables a source writes: those it creates or replaces (an OSM source's layer and tag set tables among them, named
 * `<outputTableName>_<layer>` and `<outputTableName>_<name>_<type>`), or the one it changes or drops.
 */
function tablesWritten(spec: DataSourceSpec): string[] {
    switch (spec.type) {
        case 'osm':
            return [
                spec.outputTableName,
                ...(spec.autoLoadLayers?.layers ?? []).map((layer) => `${spec.outputTableName}_${layer}`),
                ...(spec.tagSets ?? []).map((set) => `${spec.outputTableName}_${set.name}_${set.type}`),
            ];
        case 'join':
        case 'update':
        case 'drop':
            return [spec.dataRef];
        default:
            return [spec.outputTableName];
    }
}

/**
 * The data adapter `AutkGrammar` runs. Its `resolveSource(db, source)` loads one entry of a spec's `data` into the
 * autk-db database `db` (a new one when `db` is undefined), in the entry's workspace, which it leaves current, and
 * returns the database. Its `resolveWorkspaces(db, workspaces)` sets each workspace a spec's `workspaces` lists to its
 * CRS and precision grid, before the first source loads, leaves the default workspace current and returns the database.
 *
 * A host calls it to load a spec's tables exactly as the grammar does, for example on a server without a map: the
 * `./data` entry exports it with autk-db as its only import. `targets.db` names an element that lists the tables
 * after each load. `cache`, when given, receives each GeoJSON table and each table a join or an update wrote, under
 * {@link tableKey}, and loses each table a `sql` source replaces or a `drop` source drops. `computeCache` and
 * `computeTypes` are the caches a compute adapter fills (see `createComputeAdapter`): each table a source writes leaves
 * them, so maps, plots and `AutkGrammar.data`, which read them first, read what a source after compute wrote in autk-db.
 * A host that runs sources after compute (see `dataPhases`) passes them in, as the grammar does.
 */
export function createDataAdapter(targets?: Targets, cache?: GeoJsonCache, computeCache?: ComputeCache, computeTypes?: ComputeLayerTypes): Required<DataAdapter> {

    function print(db: AutkDb, targets?: Targets): void {
        if(!targets || !targets.db)
            return

        const div = document.getElementById(targets.db);
        if (div) {
            const tables = db.getTablesMetadata();

            div.innerHTML += `<ul>`;
            for (const table of tables) {
                div.innerHTML += `<li>${table.name}: (${table.source}, ${table.type}) </li>`;
            }
            div.innerHTML += `</ul>`;

            div.innerHTML += `<p>Number of tables: ${tables.length}</p>`;
        }
    }

    /**
     * Puts a table a source changed in `cache` as autk-db now exports it, as a join's, or takes it out when autk-db does
     * not export it as a layer: the plots read a table from the cache before autk-db.
     */
    async function recache(db: AutkDb, workspace: string | undefined, name: string): Promise<void> {
        if (!cache) return;
        const key = tableKey(workspace, name);
        const table = db.getTablesMetadata().find((candidate) => candidate.name === name);
        if (table && isRenderableTable(table)) cache.set(key, await db.getLayer(name));
        else cache.delete(key);
    }

    const loader = {
        async resolveWorkspaces(context: AutkDb | undefined, workspaces: WorkspaceSpec[]): Promise<AutkDb> {
            const db = await database(context);
            const named = new Set<string>();
            for (const { name, coordinateFormat, precisionGrid } of workspaces) {
                const workspace = name ?? DEFAULT_WORKSPACE_NAME;
                if (named.has(workspace))
                    throw new Error(`workspaces sets ${workspaceLabel(name)} twice; give each workspace one entry.`);
                named.add(workspace);
                // autk-db creates the workspace with this configuration, or sets it on the one that exists while it
                // holds no table, the default workspace among them.
                try {
                    await db.setWorkspace(workspace, { coordinateFormat, precisionGrid });
                } catch (err) {
                    throw new Error(`workspaces, ${workspaceLabel(name)}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            // Each source, compute pass, map and plot enters its own workspace.
            await enterWorkspace(db);
            return db;
        },

        /** Loads one entry of `data` into `context`, else a new database, in the entry's workspace. */
        async loadSource(context: AutkDb | undefined, spec: DataSourceSpec): Promise<AutkDb> {

            const db = await database(context);

            const { workspace } = spec as { workspace?: string };
            await enterWorkspace(db, workspace);

            // autk-db reads each field but `type` and the grammar's own `workspace` and `after`.
            const {type, ...rest_spec} = withoutGrammarFields(spec);

            switch (type) {
                case 'osm':
                    await db.loadOsm(toLoadOsmParams(rest_spec as OsmDataSourceSpec));
                    print(db, targets);
                    return db;
                case 'csv':
                    await db.loadCsv(rest_spec as CsvDataSourceSpec);
                    print(db, targets);
                    return db;
                case 'json':
                    await db.loadJson(rest_spec as JsonDataSourceSpec);
                    print(db, targets);
                    return db;
                case 'geojson': {
                    const geojsonSpec = rest_spec as CustomDataSourceSpec;
                    let geojsonData: FeatureCollection | undefined;

                    if (geojsonSpec.geojsonFileUrl) {
                        const response = await fetch(geojsonSpec.geojsonFileUrl);
                        geojsonData = await response.json() as FeatureCollection;
                    } else {
                        // The inline type allows a feature whose geometry is null, which autk-db refuses: loadableCollection
                        // gives such a feature an empty geometry before autk-db loads it.
                        geojsonData = geojsonSpec.geojsonObject as FeatureCollection | undefined;
                    }

                    if (cache && geojsonData) {
                        cache.set(tableKey(workspace, geojsonSpec.outputTableName), geojsonData);
                        // autk-db reads a GeoJSON source in EPSG:4326 unless it names another CRS.
                        noteSourceCrs(geojsonData, geojsonSpec.coordinateFormat ?? 'EPSG:4326');
                    }

                    // Pass the fetched object directly so autk-db doesn't need to re-fetch, as autk-db loads it (see
                    // loadableCollection). The cache keeps the source's own rows, in their order, for its plots.
                    const loadSpec = (geojsonData
                        ? (() => { const s = { ...geojsonSpec, geojsonObject: loadableCollection(geojsonData) }; delete s.geojsonFileUrl; return s; })()
                        : geojsonSpec) as LoadGeojsonParams;

                    // Degrees put every y within -90 to 90, so a y outside it shows a layer in another CRS. The
                    // transform makes such a y infinite, and autk-db would refuse the layer with a grid error.
                    // A longitude past 180 is not checked: the transform wraps it.
                    const readAsDegrees = /^EPSG:4326$/i.test(loadSpec.coordinateFormat ?? 'EPSG:4326');
                    const extent = geojsonData && readAsDegrees ? extentOf(geojsonData) : undefined;
                    if (extent && (extent[1] < -90 || extent[3] > 90)) {
                        throw new Error(
                            `GeoJSON layer "${loadSpec.outputTableName}" has y coordinates outside -90 to 90 ` +
                            `(bbox: [${extent.join(', ')}]), so they cannot be EPSG:4326 degrees. ${crsAdvice(loadSpec.coordinateFormat)}`
                        );
                    }

                    try {
                        await db.loadGeojson(loadSpec);
                    } catch (err) {
                        throw new Error(`Failed to load GeoJSON layer "${loadSpec.outputTableName}": ${err instanceof Error ? err.message : String(err)}`);
                    }

                    // Validate that the loaded geometry is within the workspace CRS extent.
                    // A bounding box outside the valid world extent indicates a CRS mismatch.
                    try {
                        const bbox = await db.getBoundingBoxFromLayer(loadSpec.outputTableName);
                        const WORLD_EXTENT = 25_000_000; // generous bound for World Mercator (EPSG:3395), autk-db's default CRS
                        if (
                            !isFinite(bbox.minLon) || !isFinite(bbox.minLat) ||
                            !isFinite(bbox.maxLon) || !isFinite(bbox.maxLat) ||
                            Math.abs(bbox.minLon) > WORLD_EXTENT || Math.abs(bbox.maxLon) > WORLD_EXTENT ||
                            Math.abs(bbox.minLat) > WORLD_EXTENT || Math.abs(bbox.maxLat) > WORLD_EXTENT
                        ) {
                            throw new Error(
                                `Geometry bounding box after transform is invalid for layer "${loadSpec.outputTableName}" ` +
                                `(bbox: [${bbox.minLon}, ${bbox.minLat}, ${bbox.maxLon}, ${bbox.maxLat}]). ` +
                                `${crsAdvice(loadSpec.coordinateFormat)} ` +
                                `The workspace uses ${db.getWorkspaceConfiguration().coordinateFormat}; input is expected in EPSG:4326 by default.`
                            );
                        }
                    } catch (bboxErr) {
                        if (bboxErr instanceof Error && bboxErr.message.includes('bounding box after transform')) throw bboxErr;
                        // getBoundingBoxFromLayer failed (empty table, unsupported layer type, etc.): skip validation
                    }
                    print(db, targets);
                    return db;
                }
                case 'geotiff':
                    await db.loadGeoTiff(rest_spec as GeoTiffDataSourceSpec);
                    print(db, targets);
                    return db;
                case 'heatmap': {
                    const hm = rest_spec as HeatmapSourceSpec;
                    // A cell holds one value, so each entry of groupBy needs an aggregate that gives one. The schema refuses
                    // collect in a heatmap, but a spec that was not checked against it reaches here. The schema takes an
                    // entry without aggregateFn, as a join's: autk-db then lists the column's values near each cell, which
                    // no band reads, so on 4.1.1 its band read 0 in every cell, with no error. A null aggregateFn, which a
                    // JSON spec can carry, is none, as autk-db reads it.
                    if (hm.groupBy?.some((group) => (group.aggregateFn as string | undefined) === 'collect'))
                        throw new Error(`Heatmap "${hm.outputTableName}": aggregateFn "collect" lists the rows near a cell, and a cell holds one value; use sum, avg, count, min, max or weighted.`);
                    const unaggregated = hm.groupBy?.find((group) => !group.aggregateFn);
                    if (unaggregated)
                        throw new Error(`Heatmap "${hm.outputTableName}": the groupBy entry for column "${unaggregated.column}" has no aggregateFn to combine the rows near a cell, and a cell holds one value; use sum, avg, count, min, max or weighted.`);
                    // Without groupBy, one band counts the rows near each cell. autk-db labels that band, but joins the rows
                    // with no aggregate, so on 4.1.1 every cell read 0: the count is handed to autk-db as an entry of its own.
                    await db.buildHeatmap({
                        tableJoinName: hm.joinDataRef,
                        near: hm.near,
                        outputTableName: hm.outputTableName,
                        grid: hm.grid,
                        groupBy: hm.groupBy?.length ? hm.groupBy : [{ column: '*', aggregateFn: 'count' }],
                    });
                    print(db, targets);
                    return db;
                }
                case 'join': {
                    const jn = rest_spec as JoinSourceSpec;
                    await db.spatialQuery({
                        tableRootName: jn.dataRef,
                        tableJoinName: jn.joinDataRef,
                        ...(jn.near && { near: jn.near }),
                        ...(jn.groupBy && { groupBy: jn.groupBy }),
                    });
                    if (cache) {
                        const updated = await db.getLayer(jn.dataRef);
                        cache.set(tableKey(workspace, jn.dataRef), updated);
                    }
                    print(db, targets);
                    return db;
                }
                case 'sql': {
                    const sql = rest_spec as SqlSourceSpec;
                    try {
                        await db.rawQuery({
                            query: sql.query,
                            output: {
                                type: 'CREATE_TABLE',
                                tableName: sql.outputTableName,
                                source: 'user',
                                ...(sql.layerType !== undefined && { tableType: sql.layerType }),
                            },
                        });
                    } catch (err) {
                        const reason = err instanceof Error ? err.message : String(err);
                        // autk-db puts the geometry of a table a query saves on the workspace's grid, read from a column
                        // named geometry, with a layerType or without one, so a geometry under another name fails there
                        // with DuckDB's binder error for that column.
                        const advice = /Referenced column "geometry" not found/i.test(reason)
                            ? 'autk-db reads the geometry of a table it saves from a column named geometry, so a query returns its geometry as geometry, for example ST_Centroid(geometry) AS geometry. autk-db: '
                            : '';
                        throw new Error(`SQL source "${sql.outputTableName}": ${advice}${reason}`);
                    }
                    // A query saved under the name of a GeoJSON table replaces it, so the plots no longer read its rows.
                    cache?.delete(tableKey(workspace, sql.outputTableName));
                    print(db, targets);
                    return db;
                }
                case 'update': {
                    const update = rest_spec as UpdateSourceSpec;
                    const refuse = (message: string) => new Error(`Update of "${update.dataRef}": ${message}`);
                    // The schema refuses these shapes too, but a spec that was not checked against it reaches here.
                    if ((update.geojsonObject === undefined) === (update.jsonObject === undefined))
                        throw refuse('give its rows in geojsonObject or in jsonObject, one of the two.');
                    if (update.strategy === 'update' && !update.idColumn)
                        throw refuse("the update strategy needs an idColumn, the column that matches a given row to the table's rows.");
                    let data = (update.geojsonObject ?? update.jsonObject) as FeatureCollection | Record<string, unknown>[];
                    let idColumn = update.idColumn;
                    try {
                        const table = db.getTablesMetadata().find((candidate) => candidate.name === update.dataRef);
                        // autk-db cannot update a layer of plain columns (see keepsPlainColumns): on 4.1.1 such an update
                        // failed for want of a feature id or of a column, or on rows that were not a FeatureCollection.
                        if (update.strategy === 'update' && table && isVectorTable(table) && keepsPlainColumns(table))
                            throw new Error("on a layer, the update strategy sets the properties column of each row it matches, and this layer has none: it keeps its values in plain columns, as a CSV or JSON layer or a sql source's table of plain columns does. Use strategy 'replace', with every row in geojsonObject.");
                        // autk-db inserts the given rows of a table without a geometry by position, so each comes in the
                        // table's column order. replace makes the table of the given rows, by their keys' names.
                        if (update.strategy === 'update' && update.jsonObject && table && !isVectorTable(table))
                            data = inColumnOrder(update.jsonObject, table);
                        // A layer keyed by a feature property is matched here, then updated by its rows' feature ids.
                        if (update.strategy === 'update' && update.geojsonObject && idColumn?.startsWith('properties.') && table && isVectorTable(table)) {
                            ({ data, idColumn } = await updateByFeatureId(db, table, update.geojsonObject as FeatureCollection, idColumn.slice('properties.'.length)));
                            // No row has a given key, so the table stays as it is, as autk-db leaves it.
                            if ((data as FeatureCollection).features.length === 0) {
                                print(db, targets);
                                return db;
                            }
                        }
                        await db.updateTable({
                            tableName: update.dataRef,
                            data,
                            strategy: update.strategy,
                            ...(idColumn !== undefined && { idColumn }),
                        });
                    } catch (err) {
                        throw refuse(err instanceof Error ? err.message : String(err));
                    }
                    await recache(db, workspace, update.dataRef);
                    print(db, targets);
                    return db;
                }
                case 'drop': {
                    const drop = rest_spec as DropSourceSpec;
                    // autk-db drops a table it does not hold without a word, so a name that names none is refused here.
                    if (!db.getTablesMetadata().some((table) => table.name === drop.dataRef))
                        throw new Error(`Drop of "${drop.dataRef}": ${workspaceLabel(workspace)} holds no table of that name.`);
                    await db.removeLayer(drop.dataRef);
                    cache?.delete(tableKey(workspace, drop.dataRef));
                    print(db, targets);
                    return db;
                }
                default:
                    // The schema refuses any other type, but a spec that was not checked against it reaches here. Handing
                    // the engine no database would make the next source start a new one, without the tables before it.
                    throw new Error(`Unknown data source type "${String(type)}".`);
            }
        }
    };

    return {
        resolveWorkspaces: loader.resolveWorkspaces,

        async resolveSource(context: AutkDb | undefined, spec: DataSourceSpec): Promise<AutkDb> {
            const db = await loader.loadSource(context, spec);
            // A table a source writes is autk-db's from then on. Maps, plots and `grammar.data` read the compute
            // adapter's caches first, so a pass's result there, which a source after compute changed, goes.
            const { workspace } = spec as { workspace?: string };
            for (const name of tablesWritten(spec)) {
                computeCache?.delete(tableKey(workspace, name));
                computeTypes?.delete(tableKey(workspace, name));
            }
            return db;
        },
    };
}
