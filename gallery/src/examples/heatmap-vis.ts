import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            queryArea: {
                geocodeArea: 'New York',
                areas: ['Battery Park City', 'Financial District'],
            },
            outputTableName: 'table_osm',
            autoLoadLayers: {
                layers: ['surface', 'parks', 'water', 'roads'] as Array<
                    'surface' | 'parks' | 'water' | 'roads' | 'buildings'
                >,
                dropOsmTable: true,
            },
        },
        {
            type: 'csv',
            csvFileUrl: '/data/noise.csv',
            outputTableName: 'noise',
            geometryColumns: {
                latColumnName: 'Latitude',
                longColumnName: 'Longitude',
                coordinateFormat: 'EPSG:4326',
            },
        },
        {
            type: 'heatmap',
            joinDataRef: 'noise',
            near: { distance: 1000 },
            outputTableName: 'heatmap',
            grid: { rows: 20, columns: 20 },
            groupBy: [{ column: 'Unique Key', aggregateFn: 'count' }],
        },
    ],
    map: {
        // Battery Park City and the Financial District, about 2.3 by 2.8 km, fill most of the view.
        camera: { zoom: 11.2 },
        layerRefs: [
            { dataRef: 'table_osm_surface' },
            { dataRef: 'table_osm_parks' },
            { dataRef: 'table_osm_water' },
            { dataRef: 'table_osm_roads' },
            { dataRef: 'heatmap', opacity: 0.5, getFnv: 'count.noise', defaultFnv: 0 },
        ],
    },
};
