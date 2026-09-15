import { CsvDataSourceSpec, CustomDataSourceSpec, DataAdapter, DataSourceSpec, HeatmapSourceSpec, JoinSourceSpec, JsonDataSourceSpec, OsmDataSourceSpec } from '@urban-toolkit/the-urban-grammar';
import { AutkDb, DEFAULT_WORKSPACE_COORDINATE_FORMAT } from '@urban-toolkit/autk-db';
import type { FeatureCollection } from 'geojson';
import { Targets, GeoJsonCache } from '../types';

/**
 * Maps an OSM source onto autk-db's parameters, which always expect
 * `autoLoadLayers` and no longer take `dropOsmTable`.
 */
function toLoadOsmParams(spec: OsmDataSourceSpec) {
    const { autoLoadLayers, ...rest } = spec;
    return { ...rest, autoLoadLayers: { layers: autoLoadLayers?.layers ?? [] } };
}

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

            let {type, ...rest_spec} = spec;

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
                        geojsonData = geojsonSpec.geojsonObject;
                    }

                    if (cache && geojsonData) cache.set(geojsonSpec.outputTableName, geojsonData);

                    // Pass the fetched object directly so autk-db doesn't need to re-fetch
                    const loadSpec = geojsonData
                        ? (() => { const s = { ...geojsonSpec, geojsonObject: geojsonData }; delete s.geojsonFileUrl; return s; })()
                        : geojsonSpec;

                    try {
                        await db.loadGeojson(loadSpec);
                    } catch (err) {
                        const crsHint = loadSpec.coordinateFormat
                            ? `coordinateFormat is set to "${loadSpec.coordinateFormat}"`
                            : `no coordinateFormat was specified — defaulting to EPSG:4326 (WGS84 per RFC 7946)`;
                        throw new Error(
                            `Failed to load GeoJSON layer "${loadSpec.outputTableName}": ${err instanceof Error ? err.message : String(err)}. ` +
                            `${crsHint}. Verify that coordinateFormat matches the actual CRS of the input data.`
                        );
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
                                `Verify that coordinateFormat matches the actual CRS of the input data. ` +
                                `The workspace uses ${DEFAULT_WORKSPACE_COORDINATE_FORMAT}; input is expected in EPSG:4326 by default.`
                            );
                        }
                    } catch (bboxErr) {
                        if (bboxErr instanceof Error && bboxErr.message.includes('bounding box after transform')) throw bboxErr;
                        // getBoundingBoxFromLayer failed (empty table, unsupported layer type, etc.) — skip validation
                    }
                    print(db, targets);
                    return db;
                }
                case 'heatmap': {
                    const hm = rest_spec as HeatmapSourceSpec;
                    await db.buildHeatmap({
                        tableJoinName: hm.tableJoinName,
                        near: { distance: hm.near.distance },
                        outputTableName: hm.outputTableName,
                        grid: hm.grid,
                        ...(hm.groupBy && { groupBy: hm.groupBy as any }),
                    });
                    print(db, targets);
                    return db;
                }
                case 'join': {
                    const jn = rest_spec as JoinSourceSpec;
                    await db.spatialQuery({
                        tableRootName: jn.tableRootName,
                        tableJoinName: jn.tableJoinName,
                        ...(jn.near && { near: jn.near }),
                        ...(jn.groupBy && { groupBy: jn.groupBy }),
                    });
                    if (cache) {
                        const updated = await db.getLayer(jn.tableRootName);
                        cache.set(jn.tableRootName, updated);
                    }
                    print(db, targets);
                    return db;
                }
                default:
                    return
            }
        }
    }
}
