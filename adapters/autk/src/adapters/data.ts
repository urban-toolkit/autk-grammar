import { CsvDataSourceSpec, CustomDataSourceSpec, DataAdapter, DataSourceSpec, GeoTiffDataSourceSpec, HeatmapSourceSpec, JoinSourceSpec, JsonDataSourceSpec, OsmDataSourceSpec } from '@urban-toolkit/the-urban-grammar';
import { AutkDb, DEFAULT_WORKSPACE_COORDINATE_FORMAT } from '@urban-toolkit/autk-db';
import type { LoadGeojsonParams } from '@urban-toolkit/autk-db';
import type { FeatureCollection, Geometry } from 'geojson';
import { Targets, GeoJsonCache } from '../types';
import { enterWorkspace, tableKey } from '../workspace';
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
 * Maps an OSM source onto autk-db's parameters, which always expect
 * `autoLoadLayers` and no longer take `dropOsmTable`.
 */
function toLoadOsmParams(spec: OsmDataSourceSpec) {
    const { autoLoadLayers, ...rest } = spec;
    return { ...rest, queryArea: queryAreaOf(spec), autoLoadLayers: { layers: autoLoadLayers?.layers ?? [] } };
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

/**
 * The data adapter `AutkGrammar` runs. Its `resolveSource(db, source)` loads one entry of a spec's `data` into the
 * autk-db database `db` (a new one when `db` is undefined), in the entry's workspace, which it leaves current, and
 * returns the database.
 *
 * A host calls it to load a spec's tables exactly as the grammar does, for example on a server without a map: the
 * `./data` entry exports it with autk-db as its only import. `targets.db` names an element that lists the tables
 * after each load. `cache`, when given, receives each GeoJSON table and each table a join wrote, under
 * {@link tableKey}.
 */
export function createDataAdapter(targets?: Targets, cache?: GeoJsonCache): DataAdapter {

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

    return {
        async resolveSource(context: AutkDb | undefined, spec: DataSourceSpec): Promise<AutkDb | undefined> {

            let db = context;

            if(!db){
                db = new AutkDb();
                await db.init();
            }

            const { workspace } = spec as { workspace?: string };
            await enterWorkspace(db, workspace);

            let {type, workspace: _workspace, ...rest_spec} = spec as DataSourceSpec & { workspace?: string };

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

                    if (cache && geojsonData) cache.set(tableKey(workspace, geojsonSpec.outputTableName), geojsonData);

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
                        const WORLD_EXTENT = 25_000_000; // generous bound for DEFAULT_WORKSPACE_COORDINATE_FORMAT (EPSG:3395)
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
                                `The workspace uses ${DEFAULT_WORKSPACE_COORDINATE_FORMAT}; input is expected in EPSG:4326 by default.`
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
                    // The schema refuses collect in a heatmap, but a spec that was not checked against it reaches here.
                    if (hm.groupBy?.some((group) => (group.aggregateFn as string | undefined) === 'collect'))
                        throw new Error(`Heatmap "${hm.outputTableName}": aggregateFn "collect" lists the rows near a cell, and a cell holds one value; use sum, avg, count, min, max or weighted.`);
                    await db.buildHeatmap({
                        tableJoinName: hm.joinDataRef,
                        near: hm.near,
                        outputTableName: hm.outputTableName,
                        grid: hm.grid,
                        ...(hm.groupBy && { groupBy: hm.groupBy }),
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
                default:
                    // The schema refuses any other type, but a spec that was not checked against it reaches here. Handing
                    // the engine no database would make the next source start a new one, without the tables before it.
                    throw new Error(`Unknown data source type "${String(type)}".`);
            }
        }
    }
}
