import type { FeatureCollection, Feature, GeoJsonGeometryTypes } from 'geojson';
import type { DataAdapter, DataSourceSpec, OsmDataSourceSpec, CsvDataSourceSpec, JsonDataSourceSpec, CustomDataSourceSpec } from '@urban-toolkit/the-urban-grammar';
import type { LayerType } from '@urban-toolkit/the-urban-grammar';
import Papa from 'papaparse';
import { DeckGlDb, Targets } from '../types';

// --- OSM ---

type OverpassElement = {
    type: 'node' | 'way' | 'relation';
    id: number;
    lat?: number;
    lon?: number;
    tags?: Record<string, string>;
    geometry?: { lat: number; lon: number }[];
};

type OverpassResponse = {
    elements: OverpassElement[];
};

const LAYER_TYPE_TO_OSM_TAGS: Partial<Record<LayerType, [string, string][]>> = {
    buildings: [['building', '*']],
    roads:     [['highway', '*']],
    water:     [['waterway', '*'], ['natural', 'water']],
    parks:     [['leisure', 'park'], ['landuse', 'recreation_ground']],
    surface:   [['landuse', '*']],
};

function buildOverpassQuery(spec: OsmDataSourceSpec): string {
    const area = spec.queryArea.geocodeArea;
    const layers = spec.autoLoadLayers?.layers ?? [];

    const filters: string[] = [];

    for (const layer of layers) {
        const tags = LAYER_TYPE_TO_OSM_TAGS[layer];
        if (!tags) continue;
        for (const [key, val] of tags) {
            const valFilter = val === '*' ? '' : `="${val}"`;
            filters.push(`  way["${key}"${valFilter}](area.searchArea);`);
            filters.push(`  relation["${key}"${valFilter}](area.searchArea);`);
        }
    }

    if (filters.length === 0) {
        filters.push('  nwr(area.searchArea);');
    }

    return `[out:json][timeout:90];
area[name="${area}"]->.searchArea;
(
${filters.join('\n')}
);
out geom;`;
}

function overpassToGeojson(response: OverpassResponse): FeatureCollection {
    const features: Feature[] = [];

    for (const el of response.elements) {
        if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
                properties: el.tags ?? {},
            });
        } else if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
            const coords = el.geometry.map(p => [p.lon, p.lat]);
            const isClosed =
                coords.length >= 4 &&
                coords[0][0] === coords[coords.length - 1][0] &&
                coords[0][1] === coords[coords.length - 1][1];
            const geomType: GeoJsonGeometryTypes = isClosed ? 'Polygon' : 'LineString';
            features.push({
                type: 'Feature',
                geometry: isClosed
                    ? { type: 'Polygon', coordinates: [coords] }
                    : { type: 'LineString', coordinates: coords },
                properties: el.tags ?? {},
                id: geomType,
            });
        }
    }

    return { type: 'FeatureCollection', features };
}

// --- CSV / JSON helpers ---

function rowsToGeojson(
    rows: Record<string, string>[],
    latCol: string,
    lonCol: string,
): FeatureCollection {
    const features: Feature[] = rows
        .map((row): Feature | null => {
            const lat = parseFloat(row[latCol]);
            const lon = parseFloat(row[lonCol]);
            if (isNaN(lat) || isNaN(lon)) return null;
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: row,
            };
        })
        .filter((f): f is Feature => f !== null);

    return { type: 'FeatureCollection', features };
}

function objectsToGeojson(
    items: Record<string, unknown>[],
    latCol: string,
    lonCol: string,
): FeatureCollection {
    const features: Feature[] = items
        .map((item): Feature | null => {
            const lat = parseFloat(String(item[latCol]));
            const lon = parseFloat(String(item[lonCol]));
            if (isNaN(lat) || isNaN(lon)) return null;
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: item as Record<string, unknown>,
            };
        })
        .filter((f): f is Feature => f !== null);

    return { type: 'FeatureCollection', features };
}

// --- Debug display ---

function printTables(db: DeckGlDb, targets?: Targets): void {
    if (!targets?.db) return;
    const div = document.getElementById(targets.db);
    if (!div) return;
    div.innerHTML += `<ul>${db.tableNames.map(n => `<li>${n}</li>`).join('')}</ul>`;
    div.innerHTML += `<p>Tables: ${db.tableNames.length}</p>`;
}

// --- Adapter factory ---

export function createDataAdapter(targets?: Targets, cache?: Map<string, FeatureCollection>): DataAdapter {
    return {
        async resolveSource(context: unknown, spec: DataSourceSpec): Promise<DeckGlDb> {
            const db = (context instanceof DeckGlDb) ? context : new DeckGlDb();
            const { type, ...rest } = spec;

            switch (type) {
                case 'geojson': {
                    const s = rest as CustomDataSourceSpec;
                    let data: FeatureCollection;

                    if (s.geojsonFileUrl) {
                        const res = await fetch(s.geojsonFileUrl);
                        data = await res.json() as FeatureCollection;
                    } else if (s.geojsonObject) {
                        data = s.geojsonObject;
                    } else {
                        throw new Error('geojson source requires geojsonFileUrl or geojsonObject');
                    }

                    db.add(s.outputTableName, data, 'geojson');
                    cache?.set(s.outputTableName, data);
                    printTables(db, targets);
                    return db;
                }

                case 'json': {
                    const s = rest as JsonDataSourceSpec;
                    let items: unknown[];

                    if (s.jsonFileUrl) {
                        const res = await fetch(s.jsonFileUrl);
                        items = await res.json() as unknown[];
                    } else if (s.jsonObject) {
                        items = s.jsonObject as unknown[];
                    } else {
                        throw new Error('json source requires jsonFileUrl or jsonObject');
                    }

                    let data: FeatureCollection;
                    if (s.geometryColumns) {
                        data = objectsToGeojson(
                            items as Record<string, unknown>[],
                            s.geometryColumns.latColumnName,
                            s.geometryColumns.longColumnName,
                        );
                    } else {
                        data = items as unknown as FeatureCollection;
                    }

                    db.add(s.outputTableName, data, 'json');
                    cache?.set(s.outputTableName, data);
                    printTables(db, targets);
                    return db;
                }

                case 'csv': {
                    const s = rest as CsvDataSourceSpec;
                    let rows: Record<string, string>[];

                    if (s.csvFileUrl) {
                        rows = await new Promise<Record<string, string>[]>((resolve, reject) => {
                            Papa.parse<Record<string, string>>(s.csvFileUrl!, {
                                download: true,
                                header: true,
                                delimiter: s.delimiter ?? '',
                                skipEmptyLines: true,
                                complete: (result: Papa.ParseResult<Record<string, string>>) => resolve(result.data),
                                error: (err: Error) => reject(err),
                            });
                        });
                    } else if (s.csvObject) {
                        const [header, ...dataRows] = s.csvObject as string[][];
                        rows = dataRows.map(row =>
                            Object.fromEntries(header.map((h, i) => [h, String(row[i] ?? '')])),
                        );
                    } else {
                        throw new Error('csv source requires csvFileUrl or csvObject');
                    }

                    let data: FeatureCollection;
                    if (s.geometryColumns) {
                        data = rowsToGeojson(rows, s.geometryColumns.latColumnName, s.geometryColumns.longColumnName);
                    } else {
                        const features: Feature[] = rows.map(row => ({
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [0, 0] },
                            properties: row,
                        }));
                        data = { type: 'FeatureCollection', features };
                    }

                    db.add(s.outputTableName, data, 'csv');
                    cache?.set(s.outputTableName, data);
                    printTables(db, targets);
                    return db;
                }

                case 'osm': {
                    const s = rest as OsmDataSourceSpec;
                    const query = buildOverpassQuery(s);
                    const res = await fetch('https://overpass-api.de/api/interpreter', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: `data=${encodeURIComponent(query)}`,
                    });

                    if (!res.ok) throw new Error(`Overpass API error: ${res.status}`);

                    const osmData = await res.json() as OverpassResponse;
                    const data = overpassToGeojson(osmData);

                    db.add(s.outputTableName, data, 'osm');
                    cache?.set(s.outputTableName, data);
                    printTables(db, targets);
                    return db;
                }

                case 'heatmap':
                    throw new Error(
                        `heatmap data source is not yet supported in the deck.gl adapter. ` +
                        `Use HeatmapLayer directly through the map adapter or pre-aggregate your data.`,
                    );

                case 'join':
                    throw new Error(
                        `join data source is not yet supported in the deck.gl adapter. ` +
                        `Pre-join your data before passing it to the grammar.`,
                    );

                default:
                    throw new Error(`Unknown data source type: ${(rest as DataSourceSpec).type}`);
            }
        },
    };
}
