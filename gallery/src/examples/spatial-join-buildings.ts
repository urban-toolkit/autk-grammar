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
                layers: ['surface', 'parks', 'water', 'roads', 'buildings'] as Array<
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
            type: 'join',
            dataRef: 'table_osm_buildings',
            joinDataRef: 'noise',
            near: { distance: 1000 },
            groupBy: [{ column: 'Unique Key', aggregateFn: 'count' }],
        },
    ],
    map: {
        // Battery Park City and the Financial District, about 2.3 by 2.8 km, fill most of the view, tilted so the
        // buildings rise.
        camera: { zoom: 11.3, pitch: 35 },
        layerRefs: [
            { dataRef: 'table_osm_surface' },
            { dataRef: 'table_osm_parks' },
            { dataRef: 'table_osm_water' },
            { dataRef: 'table_osm_roads' },
            { dataRef: 'table_osm_buildings', getFnv: 'sjoin.count.noise' },
        ],
    },
};
